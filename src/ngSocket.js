angular.module('ngSocketMock', []).
  service('ngSocketBackend', [function () {
    var connectQueue = [], pendingConnects = [],
        closeQueue = [], pendingCloses = [],
        sendQueue = [], pendingSends = [];

    function MockWebSocket (url) {}
    MockWebSocket.prototype.send = function (msg) {
      pendingSends.push(msg);
    };

    MockWebSocket.prototype.close = function () {
      pendingCloses.push(true);
    };

    this.createWebSocketBackend = function (url) {
      pendingConnects.push(url);

      return new MockWebSocket(url);
    };

    this.flush = function () {
      while (url = pendingConnects.shift()) {
        var i = connectQueue.indexOf(url);
        if (i > -1) {
          connectQueue.splice(i, 1);
        }
      }

      while (pendingCloses.shift()) {
        closeQueue.shift();
      }

      while (msg = pendingSends.shift()) {
        sendQueue.forEach(function(pending, i) {
          if (pending.message === msg.message) {
            j = i;
          }
        });

        if (j > -1) {
          sendQueue.splice(j, 1);
        }
      }
    };

    this.expectConnect = function (url) {
      connectQueue.push(url);
    };

    this.expectClose = function () {
      closeQueue.push(true);
    };

    this.expectSend = function (msg) {
      sendQueue.push(msg);
    };

    this.verifyNoOutstandingExpectation = function () {
      if (connectQueue.length || closeQueue.length || sendQueue.length) {
        throw new Error('Requests waiting to be flushed');
      }
    };

    this.verifyNoOutstandingRequest = function () {
      if (pendingConnects.length || pendingCloses.length || pendingSends.length) {
        throw new Error('Requests waiting to be processed');
      }
    };
  }]);

angular.module('ngSocket', []).
  service('ngSocketBackend', ['$window', function ($window) {
    this.createWebSocketBackend = function (url) {
      var match = /wss?:\/\//.exec(url);

      if (!match) {
        throw new Error('Invalid url provided');
      }

      return new $window.WebSocket(url);
    };
  }]).
  factory('ngWebSocketBackend', ['ngSocketBackend', function(ngSocketBackend){
    return ngSocketBackend;
  }]).
  factory('ngWebSocket', ['ngSocket', function(ngSocket){
    return ngSocket;
  }]).
  factory('ngSocket', ['$rootScope', '$q', 'ngSocketBackend', function ($rootScope, $q, ngSocketBackend) {
      var NGWebSocket = function (url) {
        this.url = url;
        this.sendQueue = [];
        this.onOpenCallbacks = [];
        this.onMessageCallbacks = [];
        this.onCloseCallbacks = [];
        this.fromJson = false;
        Object.freeze(this._readyStateConstants);

        this._connect();
      };

      NGWebSocket.prototype._readyStateConstants = {
        CONNECTING: 0,
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
        RECONNECT_ABORTED: 4
      };

      NGWebSocket.prototype._reconnectableStatusCodes = [
        5000
      ];

      NGWebSocket.prototype.close = function (force) {
        if (force || !this.socket.bufferedAmount) {
          this.socket.close();
        }
      };

      NGWebSocket.prototype._connect = function (force) {
        if (force || !this.socket || this.socket.readyState !== 1) {
          this.socket = ngSocketBackend.createWebSocketBackend(this.url);
          this.socket.onopen = this._onOpenHandler.bind(this);
          this.socket.onmessage = this._onMessageHandler.bind(this);
          this.socket.onclose = this._onCloseHandler.bind(this);
        }
      };

      NGWebSocket.prototype.fireQueue = function () {
        while (
            this.sendQueue.length &&
            this.socket.readyState === 1) {
          var data = this.sendQueue.shift();

          this.socket.send(typeof data.message === 'string'?
            data.message :
            JSON.stringify(data.message));
          data.deferred.resolve();
        }
      };

      NGWebSocket.prototype.notifyOpenCallbacks = function () {
        for (var i = 0; i < this.onOpenCallbacks.length; i++) {
          this.onOpenCallbacks[i].call(this);
        }
      };

      NGWebSocket.prototype.notifyCloseCallbacks = function () {
        for (var i = 0; i < this.onCloseCallbacks.length; i++) {
          this.onCloseCallbacks[i].call(this);
        }
      };

      NGWebSocket.prototype.onMessage = function (callback, options) {
        if (typeof callback !== 'function') {
          throw new Error('Callback must be a function');
        }

        if (options && typeof options.filter !== 'undefined' && typeof options.filter !== 'string'
            && !(options.filter instanceof RegExp) && typeof options.filter !== 'function') {
          throw new Error('Pattern must be a string, function or regular expression');
        }

        this.onMessageCallbacks.push({
          fn: callback,
          filter: options? options.filter : undefined,
          autoApply: options? options.autoApply : true,
          fromJson: options && options.fromJson !== undefined? options.fromJson : this.fromJson
        });
      };

      NGWebSocket.prototype._onMessageHandler = function (message) {
        var filter, jsonString, socket = this;

        try {
          jsonString = JSON.parse(message.data)
        } catch (e) { }

        for (var i = 0; i < socket.onMessageCallbacks.length; i++) {
          var callbackMessage = socket.onMessageCallbacks[i].fromJson && jsonString ? jsonString : message;

          if (socket.onMessageCallbacks[i].pattern) {
            console.warn('The usage of "pattern" on message callbacks is deprecated, please use "filter"');
            filter = socket.onMessageCallbacks[i].pattern;
          }
          else {
            filter = socket.onMessageCallbacks[i].filter;
          }

          if (filter) {
            if (typeof filter === 'string' && message.data === filter) {
              socket.onMessageCallbacks[i].fn.call(this, callbackMessage);
              safeDigest();
            }
            else if (filter instanceof RegExp && filter.exec(message.data)) {
              socket.onMessageCallbacks[i].fn.call(this, callbackMessage);
              safeDigest();
            }
            else if (typeof filter === 'function' && filter(callbackMessage) === true) {
              socket.onMessageCallbacks[i].fn.call(this, callbackMessage);
              safeDigest();
            }
          }
          else {
            socket.onMessageCallbacks[i].fn.call(this, callbackMessage);
            safeDigest();
          }
        }

        function safeDigest() {
          if (socket.onMessageCallbacks[i].autoApply && !$rootScope.$$phase) {
            $rootScope.$digest();
          }
        }
      };

      NGWebSocket.prototype.onClose = function (cb) {
        this.onCloseCallbacks.push(cb);
      };

      NGWebSocket.prototype.onOpen = function (cb) {
        this.onOpenCallbacks.push(cb);
      };

      NGWebSocket.prototype._onOpenHandler = function () {
        this.notifyOpenCallbacks();
        this.fireQueue();
      };

      NGWebSocket.prototype._onCloseHandler = function (event) {
        this.notifyCloseCallbacks();
        if (this._reconnectableStatusCodes.indexOf(event.statusCode) > -1) {
          this.reconnect();
        }
      };

      NGWebSocket.prototype.send = function (data) {
        var deferred = $q.defer(),
            socket = this,
            promise = cancelableify(deferred.promise);

        if (socket.readyState === socket._readyStateConstants.RECONNECT_ABORTED) {
          deferred.reject('Socket connection has been closed');
        }
        else {
          this.sendQueue.push({
            message: data,
            deferred: deferred
          });
          this.fireQueue();
        }

        //Credit goes to @btford
        function cancelableify(promise) {
          promise.cancel = cancel;
          var then = promise.then;
          promise.then = function() {
            var newPromise = then.apply(this, arguments);
            return cancelableify(newPromise);
          };
          return promise;
        }

        function cancel(reason) {
          socket.sendQueue.splice(socket.sendQueue.indexOf(data), 1);
          deferred.reject(reason);
          return this;
        }

        return promise;
      };

      NGWebSocket.prototype.reconnect = function () {
        this.close();
        this._connect();
      };

      NGWebSocket.prototype._setInternalState = function(state) {
        if (Math.floor(state) !== state || state < 0 || state > 4) {
          throw new Error('state must be an integer between 0 and 4, got: ' + state);
        }

        this._internalConnectionState = state;

        angular.forEach(this.sendQueue, function(pending) {
          pending.deferred.reject('Message cancelled due to closed socket connection');
        });
      };

      NGWebSocket.prototype.__defineGetter__('readyState', function () {
        return this._internalConnectionState || this.socket.readyState;
      });

      NGWebSocket.prototype.__defineSetter__('readyState', function (input) {
        throw new Error('The readyState property is read-only');
      });

      return function (url) {
        return new NGWebSocket(url);
      };
    }]);
