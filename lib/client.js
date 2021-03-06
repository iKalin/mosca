/*
Copyright (c) 2013-2014 Matteo Collina, http://matteocollina.com

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
*/
"use strict";

var async  = require("async");

var REGEXP = /(([^/])\/+$)|(([^/]))|(\/+(\/))/g;
var rewriteTopic = function(topic) {
  return topic.replace(REGEXP, "$2$4$6");
};

/**
 * The Client is just the object modelling a server representation
 * of a client
 *
 * @param {MqttConnection} conn The mqtt connection object for this client
 * @param {Server} server The Mosca server this client will be tied to
 * @api public
 */
function Client(conn, server) {
  this.connection = conn;
  conn.setPacketEncoding('binary');

  this.server = server;
  this.logger = server.logger;
  this.subscriptions = {};

  this.nextId = 1;
  this.inflight = {};
  this.inflightCounter = 0;
  this._lastDedupId = -1;

  this._setup();
}

/**
 * Sets up all the handlers, to not be called directly.
 *
 * @api private
 */
Client.prototype._setup = function() {
  var that = this, client = that.connection;

  this._buildForward();

  client.on("connect", function(packet) {
    that.handleConnect(packet);
  });

  client.on("puback", function(packet) {
    that.setUpTimer();
    that.handlePuback(packet);
  });

  client.on("pingreq", function() {
    that.logger.debug("pingreq");
    that.setUpTimer();
    that.connection.pingresp();
  });

  client.on("subscribe", function(packet) {
    that.setUpTimer();
    that.handleSubscribe(packet);
  });

  client.on("publish", function(packet) {
    that.setUpTimer();
    packet.topic = rewriteTopic(packet.topic);
    that.server.authorizePublish(that, packet.topic, packet.payload, function(err, success) {
      that.handleAuthorizePublish(err, success, packet);
    });
  });

  client.on("unsubscribe", function(packet) {
    that.setUpTimer();
    that.logger.info({ packet: packet }, "unsubscribe received");
    async.parallel(packet.unsubscriptions.map(that.unsubscribeMapTo.bind(that)), function(err) {
      if (err) {
        that.logger.warn(err);
        that.close();
        return;
      }
      client.unsuback({
        messageId: packet.messageId
      });
    });
  });

  client.on("disconnect", function() {
    that.logger.debug("disconnect requested");
    that.close();
  });

  client.on("error", function(err) {
    that.logger.warn(err);
    that.onNonDisconnectClose();
  });

  client.on("close", function() {
    if (!that._closed || !that._closing) {
      that.onNonDisconnectClose();
    }
  });
};

/**
 * Sets up the keepalive timer.
 * To not be called directly.
 *
 * @api private
 */
Client.prototype.setUpTimer = function() {
  if (this.timer) {
    clearTimeout(this.timer);
  }

  if (this.keepalive <= 0) {
    return;
  }

  var timeout = this.keepalive * 1000 * 3 / 2;
  var that = this;

  this.logger.debug({ timeout: timeout }, "setting keepalive timeout");

  this.timer = setTimeout(function() {
    that.logger.info("keepalive timeout");
    that.close();
  }, timeout);
};

/**
 * Builds the forward property for this object.
 * It wraps 'this' inside a closure.
 *
 * @api private
 */
Client.prototype._buildForward = function() {
  var that = this;
  this.forward = function(topic, payload, options, subTopic, qos, cb) {
    if (options._dedupId <= that._lastDedupId) {
      return;
    }

    that.logger.trace({ topic: topic }, "delivering message");

    var sub = that.subscriptions[subTopic],
        indexWildcard = subTopic.indexOf("#"),
        indexPlus = subTopic.indexOf("+"),
        forward = true,
        newId = this.nextId++;

    var packet = {
      topic: topic,
      payload: payload,
      qos: qos,
      messageId: newId
    };

    if (that._closed || that._closing) {
      that.logger.debug({ packet: packet }, "trying to send a packet to a disconnected client");
      forward = false;
    } else if (that.inflightCounter >= that.server.opts.maxInflightMessages) {
      that.logger.warn("too many inflight packets, closing");
      that.close();
      forward = false;
    }

    if (cb) {
      cb();
    }

    // skip delivery of messages in $SYS for wildcards
    forward = forward &&
              ! ( topic.indexOf('$SYS') >= 0 &&
                  (
                    indexWildcard >= 0 &&
                    indexWildcard < 2 ||
                    indexPlus >= 0 &&
                    indexPlus < 2
                  )
                );

    function doForward() {
      if (options._dedupId === undefined) {
        options._dedupId = that.server.nextDedupId();
        that._lastDedupId = options._dedupId;
      }

      that.connection.publish(packet);

      if (packet.qos === 1) {
        that.inflight[packet.messageId] = packet;
        that.inflightCounter++;
      }
    }

    if (forward) {
      if (options.offline) {
        that.server.updateOfflinePacket(that, options, packet.messageId, doForward);
      } else {
        doForward();
      }
    }
  };
};

/**
 * Builds a function for unsubscribing from a topic.
 *
 * @api private
 */
Client.prototype.unsubscribeMapTo = function(topic) {
  var that = this;
  return function(cb) {
    var sub = that.subscriptions[topic],
    handler = (sub && sub.handler) || that.forward;
    that.server.ascoltatore.unsubscribe(topic, handler, function(err) {
      if (err) {
        cb(err);
        return;
      }
      if (!that._closing || that.clean) {
        delete that.subscriptions[topic];
        that.logger.info({ topic: topic }, "unsubscribed");
        that.server.emit("unsubscribed", topic, that);
      }
      cb();
    });
  };
};

/**
 * Handle a connect packet, doing authentication.
 *
 * @api private
 */
Client.prototype.handleConnect = function(packet) {
  var that = this, logger, client = this.connection;

  this.id = packet.clientId;
  this.logger = logger = that.logger.child({ client: this });

  that.server.authenticate(this, packet.username, packet.password,
                           function(err, verdict) {

    if (err) {
      logger.info({ username: packet.username }, "authentication error");
      client.stream.end();
      that.connection.emit("error", err);
      return;
    }

    if (!verdict) {
      logger.info({ username: packet.username }, "authentication denied");
      client.connack({
        returnCode: 5
      });
      client.stream.end();
      return;
    }

    that.keepalive = packet.keepalive;
    that.will = packet.will;
    if (that.will) {
      that.will.topic = rewriteTopic(that.will.topic);
    }

    that.clean = packet.clean;

    var completeConnection = function(){
      that.setUpTimer();

      that.server.restoreClientSubscriptions(that, function() {
        client.connack({
          returnCode: 0
        });

        logger.info("client connected");
        that.server.emit("clientConnected", that);
        that.server.forwardOfflinePackets(that);
      });
    };

    if (that.id in that.server.clients){
      that.server.clients[that.id].close(completeConnection);
    } else {
      completeConnection();
    }
  });
};

/**
 * Handle a puback packet.
 *
 * @api private
 */
Client.prototype.handlePuback = function(packet) {
  var logger = this.logger;
  var that = this;

  logger.debug({ packet: packet }, "puback");
  if (this.inflight[packet.messageId]) {
    this.inflightCounter--;
    delete this.inflight[packet.messageId];
    this.server.deleteOfflinePacket(this, packet.messageId, function(err) {
      if (err) {
        return that.emit("error", err);
      }
      logger.debug({ packet: packet }, "cleaned offline packet");
    });
  } else {
    logger.info({ packet: packet }, "no matching packet");
  }
};

/**
 * Calculate the QoS of the subscriptions.
 *
 * @api private
 */
function calculateGranted(client, packet) {
  return packet.subscriptions.map(function(e) {
    if (e.qos === 2) {
      e.qos = 1;
    }
    if (client.subscriptions[e.topic] !== undefined) {
      client.subscriptions[e.topic].qos = e.qos;
    }
    return e.qos;
  });
}

/**
 * Handle the result of the Server's authorizeSubscribe method.
 *
 * @api private
 */
Client.prototype.handleAuthorizeSubscribe = function(err, success, s, cb) {
  if (err) {
    cb(err);
    return;
  }

  if (!success) {
    this.logger.info({ topic: s.topic }, "subscribe not authorized");
    cb("not authorized");
    return;
  }

  var that = this;

  var handler = function(topic, payload, options) {
    that.forward(topic, payload, options, s.topic, s.qos);
  };

  this.server.ascoltatore.subscribe(
    s.topic,
    handler,
    function(err) {
      if (err) {
        cb(err);
        return;
      }
      that.logger.info({ topic: s.topic, qos: s.qos }, "subscribed to topic");
      that.subscriptions[s.topic] = { qos: s.qos, handler: handler };
      cb();
    }
  );
};

/**
 * Handle a subscribe packet.
 *
 * @api private
 */
Client.prototype.handleSubscribe = function(packet) {
  var that = this, server = this.server, logger = this.logger;

  logger.debug({ packet: packet }, "subscribe received");

  var granted = calculateGranted(this, packet);
  var subs = packet.subscriptions.filter(function(s) {
    s.topic = rewriteTopic(s.topic);
    return that.subscriptions[s.topic] === undefined;
  });

  async.parallel(subs.map(function(s) {
    return function(cb) {
      server.authorizeSubscribe(that, s.topic, function(err, success) {
        that.handleAuthorizeSubscribe(err, success, s, cb);
      });
    };
  }), function(err) {
    if (err) {
      that.close();
      return;
    }

    packet.subscriptions.forEach(function(sub) {
      that.server.forwardRetained(sub.topic, that);
      that.server.emit("subscribed", sub.topic, that);
    });

    if(!that._closed) {
      that.connection.suback({
        messageId: packet.messageId,
        granted: granted
      });
    }
  });
};

/**
 * Handle the result of a call to the Server's authorizePublish
 *
 * @api private
 */
Client.prototype.handleAuthorizePublish = function(err, success, packet) {
  var that = this;

  if (err || !success) {
    that.close();
    return;
  }

  that.server.publish(packet, that, function() {
    if (packet.qos === 1 && !(that._closed || that._closing)) {
      that.connection.puback({
        messageId: packet.messageId
      });
    }
  });
};

/**
 * Stuff to do when a client closes without a disconnect.
 * it also deliver the client last will.
 *
 * @api private
 */
Client.prototype.onNonDisconnectClose = function() {
  var that = this, logger = that.logger;

  if (that.will) {
    // needed to avoid possible race conditions.
    setImmediate(function() {
      logger.info({ willTopic: that.will.topic }, "delivering last will");
      that.server.publish(that.will);
    });
  }

  this.close();
};

/**
 * Close the client
 *
 * @api public
 * @param {Function} callback The callback to be called when the Client is closed
 */
Client.prototype.close = function(callback) {

  if (this._closed || this._closing) {
    if (callback) {
      return callback();
    } else {
      return;
    }
  }

  var that = this;

  if (this.id) {
    that.logger.debug("closing client");

    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  var cleanup = function() {
    that._closed = true;

    that.logger.info("closed");
    that.connection.removeAllListeners();
    // ignore all errors after disconnection
    that.connection.on("error", function() {});
    that.server.emit("clientDisconnected", that);

    if (callback) {
      callback();
    }
  };

  that._closing = true;

  async.parallel(Object.keys(that.subscriptions).map(that.unsubscribeMapTo.bind(that)), function() {
    that.server.persistClient(that);
    cleanup();
    that.connection.stream.end();
  });
};

module.exports = Client;
