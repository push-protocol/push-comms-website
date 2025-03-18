"use strict";
exports.id = 4984;
exports.ids = [4984];
exports.modules = {

/***/ 315:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^Readable$" }] */



const EventEmitter = __webpack_require__(24434);
const https = __webpack_require__(65692);
const http = __webpack_require__(58611);
const net = __webpack_require__(69278);
const tls = __webpack_require__(64756);
const { randomBytes, createHash } = __webpack_require__(76982);
const { Readable } = __webpack_require__(2203);
const { URL } = __webpack_require__(87016);

const PerMessageDeflate = __webpack_require__(76994);
const Receiver = __webpack_require__(79195);
const Sender = __webpack_require__(82055);
const {
  BINARY_TYPES,
  EMPTY_BUFFER,
  GUID,
  kStatusCode,
  kWebSocket,
  NOOP
} = __webpack_require__(43713);
const { addEventListener, removeEventListener } = __webpack_require__(59360);
const { format, parse } = __webpack_require__(1177);
const { toBuffer } = __webpack_require__(99405);

const readyStates = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
const protocolVersions = [8, 13];
const closeTimeout = 30 * 1000;

/**
 * Class representing a WebSocket.
 *
 * @extends EventEmitter
 */
class WebSocket extends EventEmitter {
  /**
   * Create a new `WebSocket`.
   *
   * @param {(String|URL)} address The URL to which to connect
   * @param {(String|String[])} [protocols] The subprotocols
   * @param {Object} [options] Connection options
   */
  constructor(address, protocols, options) {
    super();

    this._binaryType = BINARY_TYPES[0];
    this._closeCode = 1006;
    this._closeFrameReceived = false;
    this._closeFrameSent = false;
    this._closeMessage = '';
    this._closeTimer = null;
    this._extensions = {};
    this._protocol = '';
    this._readyState = WebSocket.CONNECTING;
    this._receiver = null;
    this._sender = null;
    this._socket = null;

    if (address !== null) {
      this._bufferedAmount = 0;
      this._isServer = false;
      this._redirects = 0;

      if (Array.isArray(protocols)) {
        protocols = protocols.join(', ');
      } else if (typeof protocols === 'object' && protocols !== null) {
        options = protocols;
        protocols = undefined;
      }

      initAsClient(this, address, protocols, options);
    } else {
      this._isServer = true;
    }
  }

  /**
   * This deviates from the WHATWG interface since ws doesn't support the
   * required default "blob" type (instead we define a custom "nodebuffer"
   * type).
   *
   * @type {String}
   */
  get binaryType() {
    return this._binaryType;
  }

  set binaryType(type) {
    if (!BINARY_TYPES.includes(type)) return;

    this._binaryType = type;

    //
    // Allow to change `binaryType` on the fly.
    //
    if (this._receiver) this._receiver._binaryType = type;
  }

  /**
   * @type {Number}
   */
  get bufferedAmount() {
    if (!this._socket) return this._bufferedAmount;

    return this._socket._writableState.length + this._sender._bufferedBytes;
  }

  /**
   * @type {String}
   */
  get extensions() {
    return Object.keys(this._extensions).join();
  }

  /**
   * @type {Function}
   */
  /* istanbul ignore next */
  get onclose() {
    return undefined;
  }

  /* istanbul ignore next */
  set onclose(listener) {}

  /**
   * @type {Function}
   */
  /* istanbul ignore next */
  get onerror() {
    return undefined;
  }

  /* istanbul ignore next */
  set onerror(listener) {}

  /**
   * @type {Function}
   */
  /* istanbul ignore next */
  get onopen() {
    return undefined;
  }

  /* istanbul ignore next */
  set onopen(listener) {}

  /**
   * @type {Function}
   */
  /* istanbul ignore next */
  get onmessage() {
    return undefined;
  }

  /* istanbul ignore next */
  set onmessage(listener) {}

  /**
   * @type {String}
   */
  get protocol() {
    return this._protocol;
  }

  /**
   * @type {Number}
   */
  get readyState() {
    return this._readyState;
  }

  /**
   * @type {String}
   */
  get url() {
    return this._url;
  }

  /**
   * Set up the socket and the internal resources.
   *
   * @param {(net.Socket|tls.Socket)} socket The network socket between the
   *     server and client
   * @param {Buffer} head The first packet of the upgraded stream
   * @param {Number} [maxPayload=0] The maximum allowed message size
   * @private
   */
  setSocket(socket, head, maxPayload) {
    const receiver = new Receiver(
      this.binaryType,
      this._extensions,
      this._isServer,
      maxPayload
    );

    this._sender = new Sender(socket, this._extensions);
    this._receiver = receiver;
    this._socket = socket;

    receiver[kWebSocket] = this;
    socket[kWebSocket] = this;

    receiver.on('conclude', receiverOnConclude);
    receiver.on('drain', receiverOnDrain);
    receiver.on('error', receiverOnError);
    receiver.on('message', receiverOnMessage);
    receiver.on('ping', receiverOnPing);
    receiver.on('pong', receiverOnPong);

    socket.setTimeout(0);
    socket.setNoDelay();

    if (head.length > 0) socket.unshift(head);

    socket.on('close', socketOnClose);
    socket.on('data', socketOnData);
    socket.on('end', socketOnEnd);
    socket.on('error', socketOnError);

    this._readyState = WebSocket.OPEN;
    this.emit('open');
  }

  /**
   * Emit the `'close'` event.
   *
   * @private
   */
  emitClose() {
    if (!this._socket) {
      this._readyState = WebSocket.CLOSED;
      this.emit('close', this._closeCode, this._closeMessage);
      return;
    }

    if (this._extensions[PerMessageDeflate.extensionName]) {
      this._extensions[PerMessageDeflate.extensionName].cleanup();
    }

    this._receiver.removeAllListeners();
    this._readyState = WebSocket.CLOSED;
    this.emit('close', this._closeCode, this._closeMessage);
  }

  /**
   * Start a closing handshake.
   *
   *          +----------+   +-----------+   +----------+
   *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
   *    |     +----------+   +-----------+   +----------+     |
   *          +----------+   +-----------+         |
   * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
   *          +----------+   +-----------+   |
   *    |           |                        |   +---+        |
   *                +------------------------+-->|fin| - - - -
   *    |         +---+                      |   +---+
   *     - - - - -|fin|<---------------------+
   *              +---+
   *
   * @param {Number} [code] Status code explaining why the connection is closing
   * @param {String} [data] A string explaining why the connection is closing
   * @public
   */
  close(code, data) {
    if (this.readyState === WebSocket.CLOSED) return;
    if (this.readyState === WebSocket.CONNECTING) {
      const msg = 'WebSocket was closed before the connection was established';
      return abortHandshake(this, this._req, msg);
    }

    if (this.readyState === WebSocket.CLOSING) {
      if (
        this._closeFrameSent &&
        (this._closeFrameReceived || this._receiver._writableState.errorEmitted)
      ) {
        this._socket.end();
      }

      return;
    }

    this._readyState = WebSocket.CLOSING;
    this._sender.close(code, data, !this._isServer, (err) => {
      //
      // This error is handled by the `'error'` listener on the socket. We only
      // want to know if the close frame has been sent here.
      //
      if (err) return;

      this._closeFrameSent = true;

      if (
        this._closeFrameReceived ||
        this._receiver._writableState.errorEmitted
      ) {
        this._socket.end();
      }
    });

    //
    // Specify a timeout for the closing handshake to complete.
    //
    this._closeTimer = setTimeout(
      this._socket.destroy.bind(this._socket),
      closeTimeout
    );
  }

  /**
   * Send a ping.
   *
   * @param {*} [data] The data to send
   * @param {Boolean} [mask] Indicates whether or not to mask `data`
   * @param {Function} [cb] Callback which is executed when the ping is sent
   * @public
   */
  ping(data, mask, cb) {
    if (this.readyState === WebSocket.CONNECTING) {
      throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    }

    if (typeof data === 'function') {
      cb = data;
      data = mask = undefined;
    } else if (typeof mask === 'function') {
      cb = mask;
      mask = undefined;
    }

    if (typeof data === 'number') data = data.toString();

    if (this.readyState !== WebSocket.OPEN) {
      sendAfterClose(this, data, cb);
      return;
    }

    if (mask === undefined) mask = !this._isServer;
    this._sender.ping(data || EMPTY_BUFFER, mask, cb);
  }

  /**
   * Send a pong.
   *
   * @param {*} [data] The data to send
   * @param {Boolean} [mask] Indicates whether or not to mask `data`
   * @param {Function} [cb] Callback which is executed when the pong is sent
   * @public
   */
  pong(data, mask, cb) {
    if (this.readyState === WebSocket.CONNECTING) {
      throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    }

    if (typeof data === 'function') {
      cb = data;
      data = mask = undefined;
    } else if (typeof mask === 'function') {
      cb = mask;
      mask = undefined;
    }

    if (typeof data === 'number') data = data.toString();

    if (this.readyState !== WebSocket.OPEN) {
      sendAfterClose(this, data, cb);
      return;
    }

    if (mask === undefined) mask = !this._isServer;
    this._sender.pong(data || EMPTY_BUFFER, mask, cb);
  }

  /**
   * Send a data message.
   *
   * @param {*} data The message to send
   * @param {Object} [options] Options object
   * @param {Boolean} [options.compress] Specifies whether or not to compress
   *     `data`
   * @param {Boolean} [options.binary] Specifies whether `data` is binary or
   *     text
   * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
   *     last one
   * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
   * @param {Function} [cb] Callback which is executed when data is written out
   * @public
   */
  send(data, options, cb) {
    if (this.readyState === WebSocket.CONNECTING) {
      throw new Error('WebSocket is not open: readyState 0 (CONNECTING)');
    }

    if (typeof options === 'function') {
      cb = options;
      options = {};
    }

    if (typeof data === 'number') data = data.toString();

    if (this.readyState !== WebSocket.OPEN) {
      sendAfterClose(this, data, cb);
      return;
    }

    const opts = {
      binary: typeof data !== 'string',
      mask: !this._isServer,
      compress: true,
      fin: true,
      ...options
    };

    if (!this._extensions[PerMessageDeflate.extensionName]) {
      opts.compress = false;
    }

    this._sender.send(data || EMPTY_BUFFER, opts, cb);
  }

  /**
   * Forcibly close the connection.
   *
   * @public
   */
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    if (this.readyState === WebSocket.CONNECTING) {
      const msg = 'WebSocket was closed before the connection was established';
      return abortHandshake(this, this._req, msg);
    }

    if (this._socket) {
      this._readyState = WebSocket.CLOSING;
      this._socket.destroy();
    }
  }
}

/**
 * @constant {Number} CONNECTING
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CONNECTING', {
  enumerable: true,
  value: readyStates.indexOf('CONNECTING')
});

/**
 * @constant {Number} CONNECTING
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CONNECTING', {
  enumerable: true,
  value: readyStates.indexOf('CONNECTING')
});

/**
 * @constant {Number} OPEN
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'OPEN', {
  enumerable: true,
  value: readyStates.indexOf('OPEN')
});

/**
 * @constant {Number} OPEN
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'OPEN', {
  enumerable: true,
  value: readyStates.indexOf('OPEN')
});

/**
 * @constant {Number} CLOSING
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CLOSING', {
  enumerable: true,
  value: readyStates.indexOf('CLOSING')
});

/**
 * @constant {Number} CLOSING
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CLOSING', {
  enumerable: true,
  value: readyStates.indexOf('CLOSING')
});

/**
 * @constant {Number} CLOSED
 * @memberof WebSocket
 */
Object.defineProperty(WebSocket, 'CLOSED', {
  enumerable: true,
  value: readyStates.indexOf('CLOSED')
});

/**
 * @constant {Number} CLOSED
 * @memberof WebSocket.prototype
 */
Object.defineProperty(WebSocket.prototype, 'CLOSED', {
  enumerable: true,
  value: readyStates.indexOf('CLOSED')
});

[
  'binaryType',
  'bufferedAmount',
  'extensions',
  'protocol',
  'readyState',
  'url'
].forEach((property) => {
  Object.defineProperty(WebSocket.prototype, property, { enumerable: true });
});

//
// Add the `onopen`, `onerror`, `onclose`, and `onmessage` attributes.
// See https://html.spec.whatwg.org/multipage/comms.html#the-websocket-interface
//
['open', 'error', 'close', 'message'].forEach((method) => {
  Object.defineProperty(WebSocket.prototype, `on${method}`, {
    enumerable: true,
    get() {
      const listeners = this.listeners(method);
      for (let i = 0; i < listeners.length; i++) {
        if (listeners[i]._listener) return listeners[i]._listener;
      }

      return undefined;
    },
    set(listener) {
      const listeners = this.listeners(method);
      for (let i = 0; i < listeners.length; i++) {
        //
        // Remove only the listeners added via `addEventListener`.
        //
        if (listeners[i]._listener) this.removeListener(method, listeners[i]);
      }
      this.addEventListener(method, listener);
    }
  });
});

WebSocket.prototype.addEventListener = addEventListener;
WebSocket.prototype.removeEventListener = removeEventListener;

module.exports = WebSocket;

/**
 * Initialize a WebSocket client.
 *
 * @param {WebSocket} websocket The client to initialize
 * @param {(String|URL)} address The URL to which to connect
 * @param {String} [protocols] The subprotocols
 * @param {Object} [options] Connection options
 * @param {(Boolean|Object)} [options.perMessageDeflate=true] Enable/disable
 *     permessage-deflate
 * @param {Number} [options.handshakeTimeout] Timeout in milliseconds for the
 *     handshake request
 * @param {Number} [options.protocolVersion=13] Value of the
 *     `Sec-WebSocket-Version` header
 * @param {String} [options.origin] Value of the `Origin` or
 *     `Sec-WebSocket-Origin` header
 * @param {Number} [options.maxPayload=104857600] The maximum allowed message
 *     size
 * @param {Boolean} [options.followRedirects=false] Whether or not to follow
 *     redirects
 * @param {Number} [options.maxRedirects=10] The maximum number of redirects
 *     allowed
 * @private
 */
function initAsClient(websocket, address, protocols, options) {
  const opts = {
    protocolVersion: protocolVersions[1],
    maxPayload: 100 * 1024 * 1024,
    perMessageDeflate: true,
    followRedirects: false,
    maxRedirects: 10,
    ...options,
    createConnection: undefined,
    socketPath: undefined,
    hostname: undefined,
    protocol: undefined,
    timeout: undefined,
    method: undefined,
    host: undefined,
    path: undefined,
    port: undefined
  };

  if (!protocolVersions.includes(opts.protocolVersion)) {
    throw new RangeError(
      `Unsupported protocol version: ${opts.protocolVersion} ` +
        `(supported versions: ${protocolVersions.join(', ')})`
    );
  }

  let parsedUrl;

  if (address instanceof URL) {
    parsedUrl = address;
    websocket._url = address.href;
  } else {
    parsedUrl = new URL(address);
    websocket._url = address;
  }

  const isUnixSocket = parsedUrl.protocol === 'ws+unix:';

  if (!parsedUrl.host && (!isUnixSocket || !parsedUrl.pathname)) {
    const err = new Error(`Invalid URL: ${websocket.url}`);

    if (websocket._redirects === 0) {
      throw err;
    } else {
      emitErrorAndClose(websocket, err);
      return;
    }
  }

  const isSecure =
    parsedUrl.protocol === 'wss:' || parsedUrl.protocol === 'https:';
  const defaultPort = isSecure ? 443 : 80;
  const key = randomBytes(16).toString('base64');
  const get = isSecure ? https.get : http.get;
  let perMessageDeflate;

  opts.createConnection = isSecure ? tlsConnect : netConnect;
  opts.defaultPort = opts.defaultPort || defaultPort;
  opts.port = parsedUrl.port || defaultPort;
  opts.host = parsedUrl.hostname.startsWith('[')
    ? parsedUrl.hostname.slice(1, -1)
    : parsedUrl.hostname;
  opts.headers = {
    'Sec-WebSocket-Version': opts.protocolVersion,
    'Sec-WebSocket-Key': key,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    ...opts.headers
  };
  opts.path = parsedUrl.pathname + parsedUrl.search;
  opts.timeout = opts.handshakeTimeout;

  if (opts.perMessageDeflate) {
    perMessageDeflate = new PerMessageDeflate(
      opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
      false,
      opts.maxPayload
    );
    opts.headers['Sec-WebSocket-Extensions'] = format({
      [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
    });
  }
  if (protocols) {
    opts.headers['Sec-WebSocket-Protocol'] = protocols;
  }
  if (opts.origin) {
    if (opts.protocolVersion < 13) {
      opts.headers['Sec-WebSocket-Origin'] = opts.origin;
    } else {
      opts.headers.Origin = opts.origin;
    }
  }
  if (parsedUrl.username || parsedUrl.password) {
    opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
  }

  if (isUnixSocket) {
    const parts = opts.path.split(':');

    opts.socketPath = parts[0];
    opts.path = parts[1];
  }

  if (opts.followRedirects) {
    if (websocket._redirects === 0) {
      websocket._originalUnixSocket = isUnixSocket;
      websocket._originalSecure = isSecure;
      websocket._originalHostOrSocketPath = isUnixSocket
        ? opts.socketPath
        : parsedUrl.host;

      const headers = options && options.headers;

      //
      // Shallow copy the user provided options so that headers can be changed
      // without mutating the original object.
      //
      options = { ...options, headers: {} };

      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          options.headers[key.toLowerCase()] = value;
        }
      }
    } else {
      const isSameHost = isUnixSocket
        ? websocket._originalUnixSocket
          ? opts.socketPath === websocket._originalHostOrSocketPath
          : false
        : websocket._originalUnixSocket
        ? false
        : parsedUrl.host === websocket._originalHostOrSocketPath;

      if (!isSameHost || (websocket._originalSecure && !isSecure)) {
        //
        // Match curl 7.77.0 behavior and drop the following headers. These
        // headers are also dropped when following a redirect to a subdomain.
        //
        delete opts.headers.authorization;
        delete opts.headers.cookie;

        if (!isSameHost) delete opts.headers.host;

        opts.auth = undefined;
      }
    }

    //
    // Match curl 7.77.0 behavior and make the first `Authorization` header win.
    // If the `Authorization` header is set, then there is nothing to do as it
    // will take precedence.
    //
    if (opts.auth && !options.headers.authorization) {
      options.headers.authorization =
        'Basic ' + Buffer.from(opts.auth).toString('base64');
    }
  }

  let req = (websocket._req = get(opts));

  if (opts.timeout) {
    req.on('timeout', () => {
      abortHandshake(websocket, req, 'Opening handshake has timed out');
    });
  }

  req.on('error', (err) => {
    if (req === null || req.aborted) return;

    req = websocket._req = null;
    emitErrorAndClose(websocket, err);
  });

  req.on('response', (res) => {
    const location = res.headers.location;
    const statusCode = res.statusCode;

    if (
      location &&
      opts.followRedirects &&
      statusCode >= 300 &&
      statusCode < 400
    ) {
      if (++websocket._redirects > opts.maxRedirects) {
        abortHandshake(websocket, req, 'Maximum redirects exceeded');
        return;
      }

      req.abort();

      let addr;

      try {
        addr = new URL(location, address);
      } catch (err) {
        emitErrorAndClose(websocket, err);
        return;
      }

      initAsClient(websocket, addr, protocols, options);
    } else if (!websocket.emit('unexpected-response', req, res)) {
      abortHandshake(
        websocket,
        req,
        `Unexpected server response: ${res.statusCode}`
      );
    }
  });

  req.on('upgrade', (res, socket, head) => {
    websocket.emit('upgrade', res);

    //
    // The user may have closed the connection from a listener of the `upgrade`
    // event.
    //
    if (websocket.readyState !== WebSocket.CONNECTING) return;

    req = websocket._req = null;

    const upgrade = res.headers.upgrade;

    if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') {
      abortHandshake(websocket, socket, 'Invalid Upgrade header');
      return;
    }

    const digest = createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    if (res.headers['sec-websocket-accept'] !== digest) {
      abortHandshake(websocket, socket, 'Invalid Sec-WebSocket-Accept header');
      return;
    }

    const serverProt = res.headers['sec-websocket-protocol'];
    const protList = (protocols || '').split(/, */);
    let protError;

    if (!protocols && serverProt) {
      protError = 'Server sent a subprotocol but none was requested';
    } else if (protocols && !serverProt) {
      protError = 'Server sent no subprotocol';
    } else if (serverProt && !protList.includes(serverProt)) {
      protError = 'Server sent an invalid subprotocol';
    }

    if (protError) {
      abortHandshake(websocket, socket, protError);
      return;
    }

    if (serverProt) websocket._protocol = serverProt;

    const secWebSocketExtensions = res.headers['sec-websocket-extensions'];

    if (secWebSocketExtensions !== undefined) {
      if (!perMessageDeflate) {
        const message =
          'Server sent a Sec-WebSocket-Extensions header but no extension ' +
          'was requested';
        abortHandshake(websocket, socket, message);
        return;
      }

      let extensions;

      try {
        extensions = parse(secWebSocketExtensions);
      } catch (err) {
        const message = 'Invalid Sec-WebSocket-Extensions header';
        abortHandshake(websocket, socket, message);
        return;
      }

      const extensionNames = Object.keys(extensions);

      if (extensionNames.length) {
        if (
          extensionNames.length !== 1 ||
          extensionNames[0] !== PerMessageDeflate.extensionName
        ) {
          const message =
            'Server indicated an extension that was not requested';
          abortHandshake(websocket, socket, message);
          return;
        }

        try {
          perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
        } catch (err) {
          const message = 'Invalid Sec-WebSocket-Extensions header';
          abortHandshake(websocket, socket, message);
          return;
        }

        websocket._extensions[PerMessageDeflate.extensionName] =
          perMessageDeflate;
      }
    }

    websocket.setSocket(socket, head, opts.maxPayload);
  });
}

/**
 * Emit the `'error'` and `'close'` event.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {Error} The error to emit
 * @private
 */
function emitErrorAndClose(websocket, err) {
  websocket._readyState = WebSocket.CLOSING;
  websocket.emit('error', err);
  websocket.emitClose();
}

/**
 * Create a `net.Socket` and initiate a connection.
 *
 * @param {Object} options Connection options
 * @return {net.Socket} The newly created socket used to start the connection
 * @private
 */
function netConnect(options) {
  options.path = options.socketPath;
  return net.connect(options);
}

/**
 * Create a `tls.TLSSocket` and initiate a connection.
 *
 * @param {Object} options Connection options
 * @return {tls.TLSSocket} The newly created socket used to start the connection
 * @private
 */
function tlsConnect(options) {
  options.path = undefined;

  if (!options.servername && options.servername !== '') {
    options.servername = net.isIP(options.host) ? '' : options.host;
  }

  return tls.connect(options);
}

/**
 * Abort the handshake and emit an error.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {(http.ClientRequest|net.Socket|tls.Socket)} stream The request to
 *     abort or the socket to destroy
 * @param {String} message The error message
 * @private
 */
function abortHandshake(websocket, stream, message) {
  websocket._readyState = WebSocket.CLOSING;

  const err = new Error(message);
  Error.captureStackTrace(err, abortHandshake);

  if (stream.setHeader) {
    stream.abort();

    if (stream.socket && !stream.socket.destroyed) {
      //
      // On Node.js >= 14.3.0 `request.abort()` does not destroy the socket if
      // called after the request completed. See
      // https://github.com/websockets/ws/issues/1869.
      //
      stream.socket.destroy();
    }

    stream.once('abort', websocket.emitClose.bind(websocket));
    websocket.emit('error', err);
  } else {
    stream.destroy(err);
    stream.once('error', websocket.emit.bind(websocket, 'error'));
    stream.once('close', websocket.emitClose.bind(websocket));
  }
}

/**
 * Handle cases where the `ping()`, `pong()`, or `send()` methods are called
 * when the `readyState` attribute is `CLOSING` or `CLOSED`.
 *
 * @param {WebSocket} websocket The WebSocket instance
 * @param {*} [data] The data to send
 * @param {Function} [cb] Callback
 * @private
 */
function sendAfterClose(websocket, data, cb) {
  if (data) {
    const length = toBuffer(data).length;

    //
    // The `_bufferedAmount` property is used only when the peer is a client and
    // the opening handshake fails. Under these circumstances, in fact, the
    // `setSocket()` method is not called, so the `_socket` and `_sender`
    // properties are set to `null`.
    //
    if (websocket._socket) websocket._sender._bufferedBytes += length;
    else websocket._bufferedAmount += length;
  }

  if (cb) {
    const err = new Error(
      `WebSocket is not open: readyState ${websocket.readyState} ` +
        `(${readyStates[websocket.readyState]})`
    );
    cb(err);
  }
}

/**
 * The listener of the `Receiver` `'conclude'` event.
 *
 * @param {Number} code The status code
 * @param {String} reason The reason for closing
 * @private
 */
function receiverOnConclude(code, reason) {
  const websocket = this[kWebSocket];

  websocket._closeFrameReceived = true;
  websocket._closeMessage = reason;
  websocket._closeCode = code;

  if (websocket._socket[kWebSocket] === undefined) return;

  websocket._socket.removeListener('data', socketOnData);
  process.nextTick(resume, websocket._socket);

  if (code === 1005) websocket.close();
  else websocket.close(code, reason);
}

/**
 * The listener of the `Receiver` `'drain'` event.
 *
 * @private
 */
function receiverOnDrain() {
  this[kWebSocket]._socket.resume();
}

/**
 * The listener of the `Receiver` `'error'` event.
 *
 * @param {(RangeError|Error)} err The emitted error
 * @private
 */
function receiverOnError(err) {
  const websocket = this[kWebSocket];

  if (websocket._socket[kWebSocket] !== undefined) {
    websocket._socket.removeListener('data', socketOnData);

    //
    // On Node.js < 14.0.0 the `'error'` event is emitted synchronously. See
    // https://github.com/websockets/ws/issues/1940.
    //
    process.nextTick(resume, websocket._socket);

    websocket.close(err[kStatusCode]);
  }

  websocket.emit('error', err);
}

/**
 * The listener of the `Receiver` `'finish'` event.
 *
 * @private
 */
function receiverOnFinish() {
  this[kWebSocket].emitClose();
}

/**
 * The listener of the `Receiver` `'message'` event.
 *
 * @param {(String|Buffer|ArrayBuffer|Buffer[])} data The message
 * @private
 */
function receiverOnMessage(data) {
  this[kWebSocket].emit('message', data);
}

/**
 * The listener of the `Receiver` `'ping'` event.
 *
 * @param {Buffer} data The data included in the ping frame
 * @private
 */
function receiverOnPing(data) {
  const websocket = this[kWebSocket];

  websocket.pong(data, !websocket._isServer, NOOP);
  websocket.emit('ping', data);
}

/**
 * The listener of the `Receiver` `'pong'` event.
 *
 * @param {Buffer} data The data included in the pong frame
 * @private
 */
function receiverOnPong(data) {
  this[kWebSocket].emit('pong', data);
}

/**
 * Resume a readable stream
 *
 * @param {Readable} stream The readable stream
 * @private
 */
function resume(stream) {
  stream.resume();
}

/**
 * The listener of the `net.Socket` `'close'` event.
 *
 * @private
 */
function socketOnClose() {
  const websocket = this[kWebSocket];

  this.removeListener('close', socketOnClose);
  this.removeListener('data', socketOnData);
  this.removeListener('end', socketOnEnd);

  websocket._readyState = WebSocket.CLOSING;

  let chunk;

  //
  // The close frame might not have been received or the `'end'` event emitted,
  // for example, if the socket was destroyed due to an error. Ensure that the
  // `receiver` stream is closed after writing any remaining buffered data to
  // it. If the readable side of the socket is in flowing mode then there is no
  // buffered data as everything has been already written and `readable.read()`
  // will return `null`. If instead, the socket is paused, any possible buffered
  // data will be read as a single chunk.
  //
  if (
    !this._readableState.endEmitted &&
    !websocket._closeFrameReceived &&
    !websocket._receiver._writableState.errorEmitted &&
    (chunk = websocket._socket.read()) !== null
  ) {
    websocket._receiver.write(chunk);
  }

  websocket._receiver.end();

  this[kWebSocket] = undefined;

  clearTimeout(websocket._closeTimer);

  if (
    websocket._receiver._writableState.finished ||
    websocket._receiver._writableState.errorEmitted
  ) {
    websocket.emitClose();
  } else {
    websocket._receiver.on('error', receiverOnFinish);
    websocket._receiver.on('finish', receiverOnFinish);
  }
}

/**
 * The listener of the `net.Socket` `'data'` event.
 *
 * @param {Buffer} chunk A chunk of data
 * @private
 */
function socketOnData(chunk) {
  if (!this[kWebSocket]._receiver.write(chunk)) {
    this.pause();
  }
}

/**
 * The listener of the `net.Socket` `'end'` event.
 *
 * @private
 */
function socketOnEnd() {
  const websocket = this[kWebSocket];

  websocket._readyState = WebSocket.CLOSING;
  websocket._receiver.end();
  this.end();
}

/**
 * The listener of the `net.Socket` `'error'` event.
 *
 * @private
 */
function socketOnError() {
  const websocket = this[kWebSocket];

  this.removeListener('error', socketOnError);
  this.on('error', NOOP);

  if (websocket) {
    websocket._readyState = WebSocket.CLOSING;
    this.destroy();
  }
}


/***/ }),

/***/ 1177:
/***/ ((module) => {



//
// Allowed token characters:
//
// '!', '#', '$', '%', '&', ''', '*', '+', '-',
// '.', 0-9, A-Z, '^', '_', '`', a-z, '|', '~'
//
// tokenChars[32] === 0 // ' '
// tokenChars[33] === 1 // '!'
// tokenChars[34] === 0 // '"'
// ...
//
// prettier-ignore
const tokenChars = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, // 80 - 95
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0 // 112 - 127
];

/**
 * Adds an offer to the map of extension offers or a parameter to the map of
 * parameters.
 *
 * @param {Object} dest The map of extension offers or parameters
 * @param {String} name The extension or parameter name
 * @param {(Object|Boolean|String)} elem The extension parameters or the
 *     parameter value
 * @private
 */
function push(dest, name, elem) {
  if (dest[name] === undefined) dest[name] = [elem];
  else dest[name].push(elem);
}

/**
 * Parses the `Sec-WebSocket-Extensions` header into an object.
 *
 * @param {String} header The field value of the header
 * @return {Object} The parsed object
 * @public
 */
function parse(header) {
  const offers = Object.create(null);

  if (header === undefined || header === '') return offers;

  let params = Object.create(null);
  let mustUnescape = false;
  let isEscaping = false;
  let inQuotes = false;
  let extensionName;
  let paramName;
  let start = -1;
  let end = -1;
  let i = 0;

  for (; i < header.length; i++) {
    const code = header.charCodeAt(i);

    if (extensionName === undefined) {
      if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i;
      } else if (code === 0x20 /* ' ' */ || code === 0x09 /* '\t' */) {
        if (end === -1 && start !== -1) end = i;
      } else if (code === 0x3b /* ';' */ || code === 0x2c /* ',' */) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }

        if (end === -1) end = i;
        const name = header.slice(start, end);
        if (code === 0x2c) {
          push(offers, name, params);
          params = Object.create(null);
        } else {
          extensionName = name;
        }

        start = end = -1;
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`);
      }
    } else if (paramName === undefined) {
      if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i;
      } else if (code === 0x20 || code === 0x09) {
        if (end === -1 && start !== -1) end = i;
      } else if (code === 0x3b || code === 0x2c) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }

        if (end === -1) end = i;
        push(params, header.slice(start, end), true);
        if (code === 0x2c) {
          push(offers, extensionName, params);
          params = Object.create(null);
          extensionName = undefined;
        }

        start = end = -1;
      } else if (code === 0x3d /* '=' */ && start !== -1 && end === -1) {
        paramName = header.slice(start, i);
        start = end = -1;
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`);
      }
    } else {
      //
      // The value of a quoted-string after unescaping must conform to the
      // token ABNF, so only token characters are valid.
      // Ref: https://tools.ietf.org/html/rfc6455#section-9.1
      //
      if (isEscaping) {
        if (tokenChars[code] !== 1) {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
        if (start === -1) start = i;
        else if (!mustUnescape) mustUnescape = true;
        isEscaping = false;
      } else if (inQuotes) {
        if (tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (code === 0x22 /* '"' */ && start !== -1) {
          inQuotes = false;
          end = i;
        } else if (code === 0x5c /* '\' */) {
          isEscaping = true;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      } else if (code === 0x22 && header.charCodeAt(i - 1) === 0x3d) {
        inQuotes = true;
      } else if (end === -1 && tokenChars[code] === 1) {
        if (start === -1) start = i;
      } else if (start !== -1 && (code === 0x20 || code === 0x09)) {
        if (end === -1) end = i;
      } else if (code === 0x3b || code === 0x2c) {
        if (start === -1) {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }

        if (end === -1) end = i;
        let value = header.slice(start, end);
        if (mustUnescape) {
          value = value.replace(/\\/g, '');
          mustUnescape = false;
        }
        push(params, paramName, value);
        if (code === 0x2c) {
          push(offers, extensionName, params);
          params = Object.create(null);
          extensionName = undefined;
        }

        paramName = undefined;
        start = end = -1;
      } else {
        throw new SyntaxError(`Unexpected character at index ${i}`);
      }
    }
  }

  if (start === -1 || inQuotes) {
    throw new SyntaxError('Unexpected end of input');
  }

  if (end === -1) end = i;
  const token = header.slice(start, end);
  if (extensionName === undefined) {
    push(offers, token, params);
  } else {
    if (paramName === undefined) {
      push(params, token, true);
    } else if (mustUnescape) {
      push(params, paramName, token.replace(/\\/g, ''));
    } else {
      push(params, paramName, token);
    }
    push(offers, extensionName, params);
  }

  return offers;
}

/**
 * Builds the `Sec-WebSocket-Extensions` header field value.
 *
 * @param {Object} extensions The map of extensions and parameters to format
 * @return {String} A string representing the given object
 * @public
 */
function format(extensions) {
  return Object.keys(extensions)
    .map((extension) => {
      let configurations = extensions[extension];
      if (!Array.isArray(configurations)) configurations = [configurations];
      return configurations
        .map((params) => {
          return [extension]
            .concat(
              Object.keys(params).map((k) => {
                let values = params[k];
                if (!Array.isArray(values)) values = [values];
                return values
                  .map((v) => (v === true ? k : `${k}=${v}`))
                  .join('; ');
              })
            )
            .join('; ');
        })
        .join(', ');
    })
    .join(', ');
}

module.exports = { format, parse };


/***/ }),

/***/ 2187:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { groupRestore, nestedRestore } = __webpack_require__(97157)

module.exports = restorer

function restorer () {
  return function compileRestore () {
    if (this.restore) {
      this.restore.state.secret = this.secret
      return
    }
    const { secret, wcLen } = this
    const paths = Object.keys(secret)
    const resetters = resetTmpl(secret, paths)
    const hasWildcards = wcLen > 0
    const state = hasWildcards ? { secret, groupRestore, nestedRestore } : { secret }
    /* eslint-disable-next-line */
    this.restore = Function(
      'o',
      restoreTmpl(resetters, paths, hasWildcards)
    ).bind(state)
    this.restore.state = state
  }
}

/**
 * Mutates the original object to be censored by restoring its original values
 * prior to censoring.
 *
 * @param {object} secret Compiled object describing which target fields should
 * be censored and the field states.
 * @param {string[]} paths The list of paths to censor as provided at
 * initialization time.
 *
 * @returns {string} String of JavaScript to be used by `Function()`. The
 * string compiles to the function that does the work in the description.
 */
function resetTmpl (secret, paths) {
  return paths.map((path) => {
    const { circle, escPath, leadingBracket } = secret[path]
    const delim = leadingBracket ? '' : '.'
    const reset = circle
      ? `o.${circle} = secret[${escPath}].val`
      : `o${delim}${path} = secret[${escPath}].val`
    const clear = `secret[${escPath}].val = undefined`
    return `
      if (secret[${escPath}].val !== undefined) {
        try { ${reset} } catch (e) {}
        ${clear}
      }
    `
  }).join('')
}

/**
 * Creates the body of the restore function
 *
 * Restoration of the redacted object happens
 * backwards, in reverse order of redactions,
 * so that repeated redactions on the same object
 * property can be eventually rolled back to the
 * original value.
 *
 * This way dynamic redactions are restored first,
 * starting from the last one working backwards and
 * followed by the static ones.
 *
 * @returns {string} the body of the restore function
 */
function restoreTmpl (resetters, paths, hasWildcards) {
  const dynamicReset = hasWildcards === true ? `
    const keys = Object.keys(secret)
    const len = keys.length
    for (var i = len - 1; i >= ${paths.length}; i--) {
      const k = keys[i]
      const o = secret[k]
      if (o) {
        if (o.flat === true) this.groupRestore(o)
        else this.nestedRestore(o)
        secret[k] = null
      }
    }
  ` : ''

  return `
    const secret = this.secret
    ${dynamicReset}
    ${resetters}
    return o
  `
}


/***/ }),

/***/ 2985:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.delay = void 0;
function delay(timeout) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(true);
        }, timeout);
    });
}
exports.delay = delay;
//# sourceMappingURL=delay.js.map

/***/ }),

/***/ 3288:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const rx = __webpack_require__(41753)

module.exports = parse

function parse ({ paths }) {
  const wildcards = []
  var wcLen = 0
  const secret = paths.reduce(function (o, strPath, ix) {
    var path = strPath.match(rx).map((p) => p.replace(/'|"|`/g, ''))
    const leadingBracket = strPath[0] === '['
    path = path.map((p) => {
      if (p[0] === '[') return p.substr(1, p.length - 2)
      else return p
    })
    const star = path.indexOf('*')
    if (star > -1) {
      const before = path.slice(0, star)
      const beforeStr = before.join('.')
      const after = path.slice(star + 1, path.length)
      const nested = after.length > 0
      wcLen++
      wildcards.push({
        before,
        beforeStr,
        after,
        nested
      })
    } else {
      o[strPath] = {
        path: path,
        val: undefined,
        precensored: false,
        circle: '',
        escPath: JSON.stringify(strPath),
        leadingBracket: leadingBracket
      }
    }
    return o
  }, {})

  return { wildcards, wcLen, secret }
}


/***/ }),

/***/ 4123:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const fastRedact = __webpack_require__(81423)
const { redactFmtSym, wildcardFirstSym } = __webpack_require__(65835)
const { rx, validator } = fastRedact

const validate = validator({
  ERR_PATHS_MUST_BE_STRINGS: () => 'pino – redacted paths must be strings',
  ERR_INVALID_PATH: (s) => `pino – redact paths array contains an invalid path (${s})`
})

const CENSOR = '[Redacted]'
const strict = false // TODO should this be configurable?

function redaction (opts, serialize) {
  const { paths, censor } = handle(opts)

  const shape = paths.reduce((o, str) => {
    rx.lastIndex = 0
    const first = rx.exec(str)
    const next = rx.exec(str)

    // ns is the top-level path segment, brackets + quoting removed.
    let ns = first[1] !== undefined
      ? first[1].replace(/^(?:"|'|`)(.*)(?:"|'|`)$/, '$1')
      : first[0]

    if (ns === '*') {
      ns = wildcardFirstSym
    }

    // top level key:
    if (next === null) {
      o[ns] = null
      return o
    }

    // path with at least two segments:
    // if ns is already redacted at the top level, ignore lower level redactions
    if (o[ns] === null) {
      return o
    }

    const { index } = next
    const nextPath = `${str.substr(index, str.length - 1)}`

    o[ns] = o[ns] || []

    // shape is a mix of paths beginning with literal values and wildcard
    // paths [ "a.b.c", "*.b.z" ] should reduce to a shape of
    // { "a": [ "b.c", "b.z" ], *: [ "b.z" ] }
    // note: "b.z" is in both "a" and * arrays because "a" matches the wildcard.
    // (* entry has wildcardFirstSym as key)
    if (ns !== wildcardFirstSym && o[ns].length === 0) {
      // first time ns's get all '*' redactions so far
      o[ns].push(...(o[wildcardFirstSym] || []))
    }

    if (ns === wildcardFirstSym) {
      // new * path gets added to all previously registered literal ns's.
      Object.keys(o).forEach(function (k) {
        if (o[k]) {
          o[k].push(nextPath)
        }
      })
    }

    o[ns].push(nextPath)
    return o
  }, {})

  // the redactor assigned to the format symbol key
  // provides top level redaction for instances where
  // an object is interpolated into the msg string
  const result = {
    [redactFmtSym]: fastRedact({ paths, censor, serialize, strict })
  }

  const topCensor = (...args) => {
    return typeof censor === 'function' ? serialize(censor(...args)) : serialize(censor)
  }

  return [...Object.keys(shape), ...Object.getOwnPropertySymbols(shape)].reduce((o, k) => {
    // top level key:
    if (shape[k] === null) {
      o[k] = (value) => topCensor(value, [k])
    } else {
      const wrappedCensor = typeof censor === 'function'
        ? (value, path) => {
            return censor(value, [k, ...path])
          }
        : censor
      o[k] = fastRedact({
        paths: shape[k],
        censor: wrappedCensor,
        serialize,
        strict
      })
    }
    return o
  }, result)
}

function handle (opts) {
  if (Array.isArray(opts)) {
    opts = { paths: opts, censor: CENSOR }
    validate(opts)
    return opts
  }
  let { paths, censor = CENSOR, remove } = opts
  if (Array.isArray(paths) === false) { throw Error('pino – redact must contain an array of strings') }
  if (remove === true) censor = undefined
  validate({ paths, censor })

  return { paths, censor }
}

module.exports = redaction


/***/ }),

/***/ 6187:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { format } = __webpack_require__(39023)

function build () {
  const codes = {}
  const emitted = new Map()

  function create (name, code, message) {
    if (!name) throw new Error('Warning name must not be empty')
    if (!code) throw new Error('Warning code must not be empty')
    if (!message) throw new Error('Warning message must not be empty')

    code = code.toUpperCase()

    if (codes[code] !== undefined) {
      throw new Error(`The code '${code}' already exist`)
    }

    function buildWarnOpts (a, b, c) {
      // more performant than spread (...) operator
      let formatted
      if (a && b && c) {
        formatted = format(message, a, b, c)
      } else if (a && b) {
        formatted = format(message, a, b)
      } else if (a) {
        formatted = format(message, a)
      } else {
        formatted = message
      }

      return {
        code,
        name,
        message: formatted
      }
    }

    emitted.set(code, false)
    codes[code] = buildWarnOpts

    return codes[code]
  }

  function emit (code, a, b, c) {
    if (codes[code] === undefined) throw new Error(`The code '${code}' does not exist`)
    if (emitted.get(code) === true) return
    emitted.set(code, true)

    const warning = codes[code](a, b, c)
    process.emitWarning(warning.message, warning.name, warning.code)
  }

  return {
    create,
    emit,
    emitted
  }
}

module.exports = build


/***/ }),

/***/ 10463:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^net|tls|https$" }] */



const EventEmitter = __webpack_require__(24434);
const http = __webpack_require__(58611);
const https = __webpack_require__(65692);
const net = __webpack_require__(69278);
const tls = __webpack_require__(64756);
const { createHash } = __webpack_require__(76982);

const PerMessageDeflate = __webpack_require__(76994);
const WebSocket = __webpack_require__(315);
const { format, parse } = __webpack_require__(1177);
const { GUID, kWebSocket } = __webpack_require__(43713);

const keyRegex = /^[+/0-9A-Za-z]{22}==$/;

const RUNNING = 0;
const CLOSING = 1;
const CLOSED = 2;

/**
 * Class representing a WebSocket server.
 *
 * @extends EventEmitter
 */
class WebSocketServer extends EventEmitter {
  /**
   * Create a `WebSocketServer` instance.
   *
   * @param {Object} options Configuration options
   * @param {Number} [options.backlog=511] The maximum length of the queue of
   *     pending connections
   * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
   *     track clients
   * @param {Function} [options.handleProtocols] A hook to handle protocols
   * @param {String} [options.host] The hostname where to bind the server
   * @param {Number} [options.maxPayload=104857600] The maximum allowed message
   *     size
   * @param {Boolean} [options.noServer=false] Enable no server mode
   * @param {String} [options.path] Accept only connections matching this path
   * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
   *     permessage-deflate
   * @param {Number} [options.port] The port where to bind the server
   * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
   *     server to use
   * @param {Function} [options.verifyClient] A hook to reject connections
   * @param {Function} [callback] A listener for the `listening` event
   */
  constructor(options, callback) {
    super();

    options = {
      maxPayload: 100 * 1024 * 1024,
      perMessageDeflate: false,
      handleProtocols: null,
      clientTracking: true,
      verifyClient: null,
      noServer: false,
      backlog: null, // use default (511 as implemented in net.js)
      server: null,
      host: null,
      path: null,
      port: null,
      ...options
    };

    if (
      (options.port == null && !options.server && !options.noServer) ||
      (options.port != null && (options.server || options.noServer)) ||
      (options.server && options.noServer)
    ) {
      throw new TypeError(
        'One and only one of the "port", "server", or "noServer" options ' +
          'must be specified'
      );
    }

    if (options.port != null) {
      this._server = http.createServer((req, res) => {
        const body = http.STATUS_CODES[426];

        res.writeHead(426, {
          'Content-Length': body.length,
          'Content-Type': 'text/plain'
        });
        res.end(body);
      });
      this._server.listen(
        options.port,
        options.host,
        options.backlog,
        callback
      );
    } else if (options.server) {
      this._server = options.server;
    }

    if (this._server) {
      const emitConnection = this.emit.bind(this, 'connection');

      this._removeListeners = addListeners(this._server, {
        listening: this.emit.bind(this, 'listening'),
        error: this.emit.bind(this, 'error'),
        upgrade: (req, socket, head) => {
          this.handleUpgrade(req, socket, head, emitConnection);
        }
      });
    }

    if (options.perMessageDeflate === true) options.perMessageDeflate = {};
    if (options.clientTracking) this.clients = new Set();
    this.options = options;
    this._state = RUNNING;
  }

  /**
   * Returns the bound address, the address family name, and port of the server
   * as reported by the operating system if listening on an IP socket.
   * If the server is listening on a pipe or UNIX domain socket, the name is
   * returned as a string.
   *
   * @return {(Object|String|null)} The address of the server
   * @public
   */
  address() {
    if (this.options.noServer) {
      throw new Error('The server is operating in "noServer" mode');
    }

    if (!this._server) return null;
    return this._server.address();
  }

  /**
   * Close the server.
   *
   * @param {Function} [cb] Callback
   * @public
   */
  close(cb) {
    if (cb) this.once('close', cb);

    if (this._state === CLOSED) {
      process.nextTick(emitClose, this);
      return;
    }

    if (this._state === CLOSING) return;
    this._state = CLOSING;

    //
    // Terminate all associated clients.
    //
    if (this.clients) {
      for (const client of this.clients) client.terminate();
    }

    const server = this._server;

    if (server) {
      this._removeListeners();
      this._removeListeners = this._server = null;

      //
      // Close the http server if it was internally created.
      //
      if (this.options.port != null) {
        server.close(emitClose.bind(undefined, this));
        return;
      }
    }

    process.nextTick(emitClose, this);
  }

  /**
   * See if a given request should be handled by this server instance.
   *
   * @param {http.IncomingMessage} req Request object to inspect
   * @return {Boolean} `true` if the request is valid, else `false`
   * @public
   */
  shouldHandle(req) {
    if (this.options.path) {
      const index = req.url.indexOf('?');
      const pathname = index !== -1 ? req.url.slice(0, index) : req.url;

      if (pathname !== this.options.path) return false;
    }

    return true;
  }

  /**
   * Handle a HTTP Upgrade request.
   *
   * @param {http.IncomingMessage} req The request object
   * @param {(net.Socket|tls.Socket)} socket The network socket between the
   *     server and client
   * @param {Buffer} head The first packet of the upgraded stream
   * @param {Function} cb Callback
   * @public
   */
  handleUpgrade(req, socket, head, cb) {
    socket.on('error', socketOnError);

    const key =
      req.headers['sec-websocket-key'] !== undefined
        ? req.headers['sec-websocket-key'].trim()
        : false;
    const upgrade = req.headers.upgrade;
    const version = +req.headers['sec-websocket-version'];
    const extensions = {};

    if (
      req.method !== 'GET' ||
      upgrade === undefined ||
      upgrade.toLowerCase() !== 'websocket' ||
      !key ||
      !keyRegex.test(key) ||
      (version !== 8 && version !== 13) ||
      !this.shouldHandle(req)
    ) {
      return abortHandshake(socket, 400);
    }

    if (this.options.perMessageDeflate) {
      const perMessageDeflate = new PerMessageDeflate(
        this.options.perMessageDeflate,
        true,
        this.options.maxPayload
      );

      try {
        const offers = parse(req.headers['sec-websocket-extensions']);

        if (offers[PerMessageDeflate.extensionName]) {
          perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
          extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
      } catch (err) {
        return abortHandshake(socket, 400);
      }
    }

    //
    // Optionally call external client verification handler.
    //
    if (this.options.verifyClient) {
      const info = {
        origin:
          req.headers[`${version === 8 ? 'sec-websocket-origin' : 'origin'}`],
        secure: !!(req.socket.authorized || req.socket.encrypted),
        req
      };

      if (this.options.verifyClient.length === 2) {
        this.options.verifyClient(info, (verified, code, message, headers) => {
          if (!verified) {
            return abortHandshake(socket, code || 401, message, headers);
          }

          this.completeUpgrade(key, extensions, req, socket, head, cb);
        });
        return;
      }

      if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
    }

    this.completeUpgrade(key, extensions, req, socket, head, cb);
  }

  /**
   * Upgrade the connection to WebSocket.
   *
   * @param {String} key The value of the `Sec-WebSocket-Key` header
   * @param {Object} extensions The accepted extensions
   * @param {http.IncomingMessage} req The request object
   * @param {(net.Socket|tls.Socket)} socket The network socket between the
   *     server and client
   * @param {Buffer} head The first packet of the upgraded stream
   * @param {Function} cb Callback
   * @throws {Error} If called more than once with the same socket
   * @private
   */
  completeUpgrade(key, extensions, req, socket, head, cb) {
    //
    // Destroy the socket if the client has already sent a FIN packet.
    //
    if (!socket.readable || !socket.writable) return socket.destroy();

    if (socket[kWebSocket]) {
      throw new Error(
        'server.handleUpgrade() was called more than once with the same ' +
          'socket, possibly due to a misconfiguration'
      );
    }

    if (this._state > RUNNING) return abortHandshake(socket, 503);

    const digest = createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${digest}`
    ];

    const ws = new WebSocket(null);
    let protocol = req.headers['sec-websocket-protocol'];

    if (protocol) {
      protocol = protocol.split(',').map(trim);

      //
      // Optionally call external protocol selection handler.
      //
      if (this.options.handleProtocols) {
        protocol = this.options.handleProtocols(protocol, req);
      } else {
        protocol = protocol[0];
      }

      if (protocol) {
        headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
        ws._protocol = protocol;
      }
    }

    if (extensions[PerMessageDeflate.extensionName]) {
      const params = extensions[PerMessageDeflate.extensionName].params;
      const value = format({
        [PerMessageDeflate.extensionName]: [params]
      });
      headers.push(`Sec-WebSocket-Extensions: ${value}`);
      ws._extensions = extensions;
    }

    //
    // Allow external modification/inspection of handshake headers.
    //
    this.emit('headers', headers, req);

    socket.write(headers.concat('\r\n').join('\r\n'));
    socket.removeListener('error', socketOnError);

    ws.setSocket(socket, head, this.options.maxPayload);

    if (this.clients) {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
    }

    cb(ws, req);
  }
}

module.exports = WebSocketServer;

/**
 * Add event listeners on an `EventEmitter` using a map of <event, listener>
 * pairs.
 *
 * @param {EventEmitter} server The event emitter
 * @param {Object.<String, Function>} map The listeners to add
 * @return {Function} A function that will remove the added listeners when
 *     called
 * @private
 */
function addListeners(server, map) {
  for (const event of Object.keys(map)) server.on(event, map[event]);

  return function removeListeners() {
    for (const event of Object.keys(map)) {
      server.removeListener(event, map[event]);
    }
  };
}

/**
 * Emit a `'close'` event on an `EventEmitter`.
 *
 * @param {EventEmitter} server The event emitter
 * @private
 */
function emitClose(server) {
  server._state = CLOSED;
  server.emit('close');
}

/**
 * Handle premature socket errors.
 *
 * @private
 */
function socketOnError() {
  this.destroy();
}

/**
 * Close the connection when preconditions are not fulfilled.
 *
 * @param {(net.Socket|tls.Socket)} socket The socket of the upgrade request
 * @param {Number} code The HTTP response status code
 * @param {String} [message] The HTTP response body
 * @param {Object} [headers] Additional HTTP response headers
 * @private
 */
function abortHandshake(socket, code, message, headers) {
  if (socket.writable) {
    message = message || http.STATUS_CODES[code];
    headers = {
      Connection: 'close',
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(message),
      ...headers
    };

    socket.write(
      `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` +
        Object.keys(headers)
          .map((h) => `${h}: ${headers[h]}`)
          .join('\r\n') +
        '\r\n\r\n' +
        message
    );
  }

  socket.removeListener('error', socketOnError);
  socket.destroy();
}

/**
 * Remove whitespace characters from both ends of a string.
 *
 * @param {String} str The string
 * @return {String} A new string representing `str` stripped of whitespace
 *     characters from both its beginning and end
 * @private
 */
function trim(str) {
  return str.trim();
}


/***/ }),

/***/ 12068:
/***/ ((module, exports) => {



const { hasOwnProperty } = Object.prototype

const stringify = configure()

// @ts-expect-error
stringify.configure = configure
// @ts-expect-error
stringify.stringify = stringify

// @ts-expect-error
stringify.default = stringify

// @ts-expect-error used for named export
exports.stringify = stringify
// @ts-expect-error used for named export
exports.configure = configure

module.exports = stringify

// eslint-disable-next-line no-control-regex
const strEscapeSequencesRegExp = /[\u0000-\u001f\u0022\u005c\ud800-\udfff]/

// Escape C0 control characters, double quotes, the backslash and every code
// unit with a numeric value in the inclusive range 0xD800 to 0xDFFF.
function strEscape (str) {
  // Some magic numbers that worked out fine while benchmarking with v8 8.0
  if (str.length < 5000 && !strEscapeSequencesRegExp.test(str)) {
    return `"${str}"`
  }
  return JSON.stringify(str)
}

function sort (array, comparator) {
  // Insertion sort is very efficient for small input sizes, but it has a bad
  // worst case complexity. Thus, use native array sort for bigger values.
  if (array.length > 2e2 || comparator) {
    return array.sort(comparator)
  }
  for (let i = 1; i < array.length; i++) {
    const currentValue = array[i]
    let position = i
    while (position !== 0 && array[position - 1] > currentValue) {
      array[position] = array[position - 1]
      position--
    }
    array[position] = currentValue
  }
  return array
}

const typedArrayPrototypeGetSymbolToStringTag =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(
      Object.getPrototypeOf(
        new Int8Array()
      )
    ),
    Symbol.toStringTag
  ).get

function isTypedArrayWithEntries (value) {
  return typedArrayPrototypeGetSymbolToStringTag.call(value) !== undefined && value.length !== 0
}

function stringifyTypedArray (array, separator, maximumBreadth) {
  if (array.length < maximumBreadth) {
    maximumBreadth = array.length
  }
  const whitespace = separator === ',' ? '' : ' '
  let res = `"0":${whitespace}${array[0]}`
  for (let i = 1; i < maximumBreadth; i++) {
    res += `${separator}"${i}":${whitespace}${array[i]}`
  }
  return res
}

function getCircularValueOption (options) {
  if (hasOwnProperty.call(options, 'circularValue')) {
    const circularValue = options.circularValue
    if (typeof circularValue === 'string') {
      return `"${circularValue}"`
    }
    if (circularValue == null) {
      return circularValue
    }
    if (circularValue === Error || circularValue === TypeError) {
      return {
        toString () {
          throw new TypeError('Converting circular structure to JSON')
        }
      }
    }
    throw new TypeError('The "circularValue" argument must be of type string or the value null or undefined')
  }
  return '"[Circular]"'
}

function getDeterministicOption (options) {
  let value
  if (hasOwnProperty.call(options, 'deterministic')) {
    value = options.deterministic
    if (typeof value !== 'boolean' && typeof value !== 'function') {
      throw new TypeError('The "deterministic" argument must be of type boolean or comparator function')
    }
  }
  return value === undefined ? true : value
}

function getBooleanOption (options, key) {
  let value
  if (hasOwnProperty.call(options, key)) {
    value = options[key]
    if (typeof value !== 'boolean') {
      throw new TypeError(`The "${key}" argument must be of type boolean`)
    }
  }
  return value === undefined ? true : value
}

function getPositiveIntegerOption (options, key) {
  let value
  if (hasOwnProperty.call(options, key)) {
    value = options[key]
    if (typeof value !== 'number') {
      throw new TypeError(`The "${key}" argument must be of type number`)
    }
    if (!Number.isInteger(value)) {
      throw new TypeError(`The "${key}" argument must be an integer`)
    }
    if (value < 1) {
      throw new RangeError(`The "${key}" argument must be >= 1`)
    }
  }
  return value === undefined ? Infinity : value
}

function getItemCount (number) {
  if (number === 1) {
    return '1 item'
  }
  return `${number} items`
}

function getUniqueReplacerSet (replacerArray) {
  const replacerSet = new Set()
  for (const value of replacerArray) {
    if (typeof value === 'string' || typeof value === 'number') {
      replacerSet.add(String(value))
    }
  }
  return replacerSet
}

function getStrictOption (options) {
  if (hasOwnProperty.call(options, 'strict')) {
    const value = options.strict
    if (typeof value !== 'boolean') {
      throw new TypeError('The "strict" argument must be of type boolean')
    }
    if (value) {
      return (value) => {
        let message = `Object can not safely be stringified. Received type ${typeof value}`
        if (typeof value !== 'function') message += ` (${value.toString()})`
        throw new Error(message)
      }
    }
  }
}

function configure (options) {
  options = { ...options }
  const fail = getStrictOption(options)
  if (fail) {
    if (options.bigint === undefined) {
      options.bigint = false
    }
    if (!('circularValue' in options)) {
      options.circularValue = Error
    }
  }
  const circularValue = getCircularValueOption(options)
  const bigint = getBooleanOption(options, 'bigint')
  const deterministic = getDeterministicOption(options)
  const comparator = typeof deterministic === 'function' ? deterministic : undefined
  const maximumDepth = getPositiveIntegerOption(options, 'maximumDepth')
  const maximumBreadth = getPositiveIntegerOption(options, 'maximumBreadth')

  function stringifyFnReplacer (key, parent, stack, replacer, spacer, indentation) {
    let value = parent[key]

    if (typeof value === 'object' && value !== null && typeof value.toJSON === 'function') {
      value = value.toJSON(key)
    }
    value = replacer.call(parent, key, value)

    switch (typeof value) {
      case 'string':
        return strEscape(value)
      case 'object': {
        if (value === null) {
          return 'null'
        }
        if (stack.indexOf(value) !== -1) {
          return circularValue
        }

        let res = ''
        let join = ','
        const originalIndentation = indentation

        if (Array.isArray(value)) {
          if (value.length === 0) {
            return '[]'
          }
          if (maximumDepth < stack.length + 1) {
            return '"[Array]"'
          }
          stack.push(value)
          if (spacer !== '') {
            indentation += spacer
            res += `\n${indentation}`
            join = `,\n${indentation}`
          }
          const maximumValuesToStringify = Math.min(value.length, maximumBreadth)
          let i = 0
          for (; i < maximumValuesToStringify - 1; i++) {
            const tmp = stringifyFnReplacer(String(i), value, stack, replacer, spacer, indentation)
            res += tmp !== undefined ? tmp : 'null'
            res += join
          }
          const tmp = stringifyFnReplacer(String(i), value, stack, replacer, spacer, indentation)
          res += tmp !== undefined ? tmp : 'null'
          if (value.length - 1 > maximumBreadth) {
            const removedKeys = value.length - maximumBreadth - 1
            res += `${join}"... ${getItemCount(removedKeys)} not stringified"`
          }
          if (spacer !== '') {
            res += `\n${originalIndentation}`
          }
          stack.pop()
          return `[${res}]`
        }

        let keys = Object.keys(value)
        const keyLength = keys.length
        if (keyLength === 0) {
          return '{}'
        }
        if (maximumDepth < stack.length + 1) {
          return '"[Object]"'
        }
        let whitespace = ''
        let separator = ''
        if (spacer !== '') {
          indentation += spacer
          join = `,\n${indentation}`
          whitespace = ' '
        }
        const maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth)
        if (deterministic && !isTypedArrayWithEntries(value)) {
          keys = sort(keys, comparator)
        }
        stack.push(value)
        for (let i = 0; i < maximumPropertiesToStringify; i++) {
          const key = keys[i]
          const tmp = stringifyFnReplacer(key, value, stack, replacer, spacer, indentation)
          if (tmp !== undefined) {
            res += `${separator}${strEscape(key)}:${whitespace}${tmp}`
            separator = join
          }
        }
        if (keyLength > maximumBreadth) {
          const removedKeys = keyLength - maximumBreadth
          res += `${separator}"...":${whitespace}"${getItemCount(removedKeys)} not stringified"`
          separator = join
        }
        if (spacer !== '' && separator.length > 1) {
          res = `\n${indentation}${res}\n${originalIndentation}`
        }
        stack.pop()
        return `{${res}}`
      }
      case 'number':
        return isFinite(value) ? String(value) : fail ? fail(value) : 'null'
      case 'boolean':
        return value === true ? 'true' : 'false'
      case 'undefined':
        return undefined
      case 'bigint':
        if (bigint) {
          return String(value)
        }
        // fallthrough
      default:
        return fail ? fail(value) : undefined
    }
  }

  function stringifyArrayReplacer (key, value, stack, replacer, spacer, indentation) {
    if (typeof value === 'object' && value !== null && typeof value.toJSON === 'function') {
      value = value.toJSON(key)
    }

    switch (typeof value) {
      case 'string':
        return strEscape(value)
      case 'object': {
        if (value === null) {
          return 'null'
        }
        if (stack.indexOf(value) !== -1) {
          return circularValue
        }

        const originalIndentation = indentation
        let res = ''
        let join = ','

        if (Array.isArray(value)) {
          if (value.length === 0) {
            return '[]'
          }
          if (maximumDepth < stack.length + 1) {
            return '"[Array]"'
          }
          stack.push(value)
          if (spacer !== '') {
            indentation += spacer
            res += `\n${indentation}`
            join = `,\n${indentation}`
          }
          const maximumValuesToStringify = Math.min(value.length, maximumBreadth)
          let i = 0
          for (; i < maximumValuesToStringify - 1; i++) {
            const tmp = stringifyArrayReplacer(String(i), value[i], stack, replacer, spacer, indentation)
            res += tmp !== undefined ? tmp : 'null'
            res += join
          }
          const tmp = stringifyArrayReplacer(String(i), value[i], stack, replacer, spacer, indentation)
          res += tmp !== undefined ? tmp : 'null'
          if (value.length - 1 > maximumBreadth) {
            const removedKeys = value.length - maximumBreadth - 1
            res += `${join}"... ${getItemCount(removedKeys)} not stringified"`
          }
          if (spacer !== '') {
            res += `\n${originalIndentation}`
          }
          stack.pop()
          return `[${res}]`
        }
        stack.push(value)
        let whitespace = ''
        if (spacer !== '') {
          indentation += spacer
          join = `,\n${indentation}`
          whitespace = ' '
        }
        let separator = ''
        for (const key of replacer) {
          const tmp = stringifyArrayReplacer(key, value[key], stack, replacer, spacer, indentation)
          if (tmp !== undefined) {
            res += `${separator}${strEscape(key)}:${whitespace}${tmp}`
            separator = join
          }
        }
        if (spacer !== '' && separator.length > 1) {
          res = `\n${indentation}${res}\n${originalIndentation}`
        }
        stack.pop()
        return `{${res}}`
      }
      case 'number':
        return isFinite(value) ? String(value) : fail ? fail(value) : 'null'
      case 'boolean':
        return value === true ? 'true' : 'false'
      case 'undefined':
        return undefined
      case 'bigint':
        if (bigint) {
          return String(value)
        }
        // fallthrough
      default:
        return fail ? fail(value) : undefined
    }
  }

  function stringifyIndent (key, value, stack, spacer, indentation) {
    switch (typeof value) {
      case 'string':
        return strEscape(value)
      case 'object': {
        if (value === null) {
          return 'null'
        }
        if (typeof value.toJSON === 'function') {
          value = value.toJSON(key)
          // Prevent calling `toJSON` again.
          if (typeof value !== 'object') {
            return stringifyIndent(key, value, stack, spacer, indentation)
          }
          if (value === null) {
            return 'null'
          }
        }
        if (stack.indexOf(value) !== -1) {
          return circularValue
        }
        const originalIndentation = indentation

        if (Array.isArray(value)) {
          if (value.length === 0) {
            return '[]'
          }
          if (maximumDepth < stack.length + 1) {
            return '"[Array]"'
          }
          stack.push(value)
          indentation += spacer
          let res = `\n${indentation}`
          const join = `,\n${indentation}`
          const maximumValuesToStringify = Math.min(value.length, maximumBreadth)
          let i = 0
          for (; i < maximumValuesToStringify - 1; i++) {
            const tmp = stringifyIndent(String(i), value[i], stack, spacer, indentation)
            res += tmp !== undefined ? tmp : 'null'
            res += join
          }
          const tmp = stringifyIndent(String(i), value[i], stack, spacer, indentation)
          res += tmp !== undefined ? tmp : 'null'
          if (value.length - 1 > maximumBreadth) {
            const removedKeys = value.length - maximumBreadth - 1
            res += `${join}"... ${getItemCount(removedKeys)} not stringified"`
          }
          res += `\n${originalIndentation}`
          stack.pop()
          return `[${res}]`
        }

        let keys = Object.keys(value)
        const keyLength = keys.length
        if (keyLength === 0) {
          return '{}'
        }
        if (maximumDepth < stack.length + 1) {
          return '"[Object]"'
        }
        indentation += spacer
        const join = `,\n${indentation}`
        let res = ''
        let separator = ''
        let maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth)
        if (isTypedArrayWithEntries(value)) {
          res += stringifyTypedArray(value, join, maximumBreadth)
          keys = keys.slice(value.length)
          maximumPropertiesToStringify -= value.length
          separator = join
        }
        if (deterministic) {
          keys = sort(keys, comparator)
        }
        stack.push(value)
        for (let i = 0; i < maximumPropertiesToStringify; i++) {
          const key = keys[i]
          const tmp = stringifyIndent(key, value[key], stack, spacer, indentation)
          if (tmp !== undefined) {
            res += `${separator}${strEscape(key)}: ${tmp}`
            separator = join
          }
        }
        if (keyLength > maximumBreadth) {
          const removedKeys = keyLength - maximumBreadth
          res += `${separator}"...": "${getItemCount(removedKeys)} not stringified"`
          separator = join
        }
        if (separator !== '') {
          res = `\n${indentation}${res}\n${originalIndentation}`
        }
        stack.pop()
        return `{${res}}`
      }
      case 'number':
        return isFinite(value) ? String(value) : fail ? fail(value) : 'null'
      case 'boolean':
        return value === true ? 'true' : 'false'
      case 'undefined':
        return undefined
      case 'bigint':
        if (bigint) {
          return String(value)
        }
        // fallthrough
      default:
        return fail ? fail(value) : undefined
    }
  }

  function stringifySimple (key, value, stack) {
    switch (typeof value) {
      case 'string':
        return strEscape(value)
      case 'object': {
        if (value === null) {
          return 'null'
        }
        if (typeof value.toJSON === 'function') {
          value = value.toJSON(key)
          // Prevent calling `toJSON` again
          if (typeof value !== 'object') {
            return stringifySimple(key, value, stack)
          }
          if (value === null) {
            return 'null'
          }
        }
        if (stack.indexOf(value) !== -1) {
          return circularValue
        }

        let res = ''

        const hasLength = value.length !== undefined
        if (hasLength && Array.isArray(value)) {
          if (value.length === 0) {
            return '[]'
          }
          if (maximumDepth < stack.length + 1) {
            return '"[Array]"'
          }
          stack.push(value)
          const maximumValuesToStringify = Math.min(value.length, maximumBreadth)
          let i = 0
          for (; i < maximumValuesToStringify - 1; i++) {
            const tmp = stringifySimple(String(i), value[i], stack)
            res += tmp !== undefined ? tmp : 'null'
            res += ','
          }
          const tmp = stringifySimple(String(i), value[i], stack)
          res += tmp !== undefined ? tmp : 'null'
          if (value.length - 1 > maximumBreadth) {
            const removedKeys = value.length - maximumBreadth - 1
            res += `,"... ${getItemCount(removedKeys)} not stringified"`
          }
          stack.pop()
          return `[${res}]`
        }

        let keys = Object.keys(value)
        const keyLength = keys.length
        if (keyLength === 0) {
          return '{}'
        }
        if (maximumDepth < stack.length + 1) {
          return '"[Object]"'
        }
        let separator = ''
        let maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth)
        if (hasLength && isTypedArrayWithEntries(value)) {
          res += stringifyTypedArray(value, ',', maximumBreadth)
          keys = keys.slice(value.length)
          maximumPropertiesToStringify -= value.length
          separator = ','
        }
        if (deterministic) {
          keys = sort(keys, comparator)
        }
        stack.push(value)
        for (let i = 0; i < maximumPropertiesToStringify; i++) {
          const key = keys[i]
          const tmp = stringifySimple(key, value[key], stack)
          if (tmp !== undefined) {
            res += `${separator}${strEscape(key)}:${tmp}`
            separator = ','
          }
        }
        if (keyLength > maximumBreadth) {
          const removedKeys = keyLength - maximumBreadth
          res += `${separator}"...":"${getItemCount(removedKeys)} not stringified"`
        }
        stack.pop()
        return `{${res}}`
      }
      case 'number':
        return isFinite(value) ? String(value) : fail ? fail(value) : 'null'
      case 'boolean':
        return value === true ? 'true' : 'false'
      case 'undefined':
        return undefined
      case 'bigint':
        if (bigint) {
          return String(value)
        }
        // fallthrough
      default:
        return fail ? fail(value) : undefined
    }
  }

  function stringify (value, replacer, space) {
    if (arguments.length > 1) {
      let spacer = ''
      if (typeof space === 'number') {
        spacer = ' '.repeat(Math.min(space, 10))
      } else if (typeof space === 'string') {
        spacer = space.slice(0, 10)
      }
      if (replacer != null) {
        if (typeof replacer === 'function') {
          return stringifyFnReplacer('', { '': value }, [], replacer, spacer, '')
        }
        if (Array.isArray(replacer)) {
          return stringifyArrayReplacer('', value, [], getUniqueReplacerSet(replacer), spacer, '')
        }
      }
      if (spacer.length !== 0) {
        return stringifyIndent('', value, [], spacer, '')
      }
    }
    return stringifySimple('', value, [])
  }

  return stringify
}


/***/ }),

/***/ 16761:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



/* eslint no-prototype-builtins: 0 */

const format = __webpack_require__(40793)
const { mapHttpRequest, mapHttpResponse } = __webpack_require__(37214)
const SonicBoom = __webpack_require__(25146)
const warning = __webpack_require__(74452)
const {
  lsCacheSym,
  chindingsSym,
  parsedChindingsSym,
  writeSym,
  serializersSym,
  formatOptsSym,
  endSym,
  stringifiersSym,
  stringifySym,
  stringifySafeSym,
  wildcardFirstSym,
  needsMetadataGsym,
  redactFmtSym,
  streamSym,
  nestedKeySym,
  formattersSym,
  messageKeySym,
  nestedKeyStrSym
} = __webpack_require__(65835)
const { isMainThread } = __webpack_require__(28167)
const transport = __webpack_require__(82563)

function noop () {}

function genLog (level, hook) {
  if (!hook) return LOG

  return function hookWrappedLog (...args) {
    hook.call(this, args, LOG, level)
  }

  function LOG (o, ...n) {
    if (typeof o === 'object') {
      let msg = o
      if (o !== null) {
        if (o.method && o.headers && o.socket) {
          o = mapHttpRequest(o)
        } else if (typeof o.setHeader === 'function') {
          o = mapHttpResponse(o)
        }
      }
      let formatParams
      if (msg === null && n.length === 0) {
        formatParams = [null]
      } else {
        msg = n.shift()
        formatParams = n
      }
      this[writeSym](o, format(msg, formatParams, this[formatOptsSym]), level)
    } else {
      this[writeSym](null, format(o, n, this[formatOptsSym]), level)
    }
  }
}

// magically escape strings for json
// relying on their charCodeAt
// everything below 32 needs JSON.stringify()
// 34 and 92 happens all the time, so we
// have a fast case for them
function asString (str) {
  let result = ''
  let last = 0
  let found = false
  let point = 255
  const l = str.length
  if (l > 100) {
    return JSON.stringify(str)
  }
  for (var i = 0; i < l && point >= 32; i++) {
    point = str.charCodeAt(i)
    if (point === 34 || point === 92) {
      result += str.slice(last, i) + '\\'
      last = i
      found = true
    }
  }
  if (!found) {
    result = str
  } else {
    result += str.slice(last)
  }
  return point < 32 ? JSON.stringify(str) : '"' + result + '"'
}

function asJson (obj, msg, num, time) {
  const stringify = this[stringifySym]
  const stringifySafe = this[stringifySafeSym]
  const stringifiers = this[stringifiersSym]
  const end = this[endSym]
  const chindings = this[chindingsSym]
  const serializers = this[serializersSym]
  const formatters = this[formattersSym]
  const messageKey = this[messageKeySym]
  let data = this[lsCacheSym][num] + time

  // we need the child bindings added to the output first so instance logged
  // objects can take precedence when JSON.parse-ing the resulting log line
  data = data + chindings

  let value
  if (formatters.log) {
    obj = formatters.log(obj)
  }
  const wildcardStringifier = stringifiers[wildcardFirstSym]
  let propStr = ''
  for (const key in obj) {
    value = obj[key]
    if (Object.prototype.hasOwnProperty.call(obj, key) && value !== undefined) {
      value = serializers[key] ? serializers[key](value) : value

      const stringifier = stringifiers[key] || wildcardStringifier

      switch (typeof value) {
        case 'undefined':
        case 'function':
          continue
        case 'number':
          /* eslint no-fallthrough: "off" */
          if (Number.isFinite(value) === false) {
            value = null
          }
        // this case explicitly falls through to the next one
        case 'boolean':
          if (stringifier) value = stringifier(value)
          break
        case 'string':
          value = (stringifier || asString)(value)
          break
        default:
          value = (stringifier || stringify)(value, stringifySafe)
      }
      if (value === undefined) continue
      propStr += ',"' + key + '":' + value
    }
  }

  let msgStr = ''
  if (msg !== undefined) {
    value = serializers[messageKey] ? serializers[messageKey](msg) : msg
    const stringifier = stringifiers[messageKey] || wildcardStringifier

    switch (typeof value) {
      case 'function':
        break
      case 'number':
        /* eslint no-fallthrough: "off" */
        if (Number.isFinite(value) === false) {
          value = null
        }
      // this case explicitly falls through to the next one
      case 'boolean':
        if (stringifier) value = stringifier(value)
        msgStr = ',"' + messageKey + '":' + value
        break
      case 'string':
        value = (stringifier || asString)(value)
        msgStr = ',"' + messageKey + '":' + value
        break
      default:
        value = (stringifier || stringify)(value, stringifySafe)
        msgStr = ',"' + messageKey + '":' + value
    }
  }

  if (this[nestedKeySym] && propStr) {
    // place all the obj properties under the specified key
    // the nested key is already formatted from the constructor
    return data + this[nestedKeyStrSym] + propStr.slice(1) + '}' + msgStr + end
  } else {
    return data + propStr + msgStr + end
  }
}

function asChindings (instance, bindings) {
  let value
  let data = instance[chindingsSym]
  const stringify = instance[stringifySym]
  const stringifySafe = instance[stringifySafeSym]
  const stringifiers = instance[stringifiersSym]
  const wildcardStringifier = stringifiers[wildcardFirstSym]
  const serializers = instance[serializersSym]
  const formatter = instance[formattersSym].bindings
  bindings = formatter(bindings)

  for (const key in bindings) {
    value = bindings[key]
    const valid = key !== 'level' &&
      key !== 'serializers' &&
      key !== 'formatters' &&
      key !== 'customLevels' &&
      bindings.hasOwnProperty(key) &&
      value !== undefined
    if (valid === true) {
      value = serializers[key] ? serializers[key](value) : value
      value = (stringifiers[key] || wildcardStringifier || stringify)(value, stringifySafe)
      if (value === undefined) continue
      data += ',"' + key + '":' + value
    }
  }
  return data
}

function getPrettyStream (opts, prettifier, dest, instance) {
  if (prettifier && typeof prettifier === 'function') {
    prettifier = prettifier.bind(instance)
    return prettifierMetaWrapper(prettifier(opts), dest, opts)
  }
  try {
    const prettyFactory = Object(function webpackMissingModule() { var e = new Error("Cannot find module 'pino-pretty'"); e.code = 'MODULE_NOT_FOUND'; throw e; }())
    prettyFactory.asMetaWrapper = prettifierMetaWrapper
    return prettifierMetaWrapper(prettyFactory(opts), dest, opts)
  } catch (e) {
    if (e.message.startsWith("Cannot find module 'pino-pretty'")) {
      throw Error('Missing `pino-pretty` module: `pino-pretty` must be installed separately')
    };
    throw e
  }
}

function prettifierMetaWrapper (pretty, dest, opts) {
  opts = Object.assign({ suppressFlushSyncWarning: false }, opts)
  let warned = false
  return {
    [needsMetadataGsym]: true,
    lastLevel: 0,
    lastMsg: null,
    lastObj: null,
    lastLogger: null,
    flushSync () {
      if (opts.suppressFlushSyncWarning || warned) {
        return
      }
      warned = true
      setMetadataProps(dest, this)
      dest.write(pretty(Object.assign({
        level: 40, // warn
        msg: 'pino.final with prettyPrint does not support flushing',
        time: Date.now()
      }, this.chindings())))
    },
    chindings () {
      const lastLogger = this.lastLogger
      let chindings = null

      // protection against flushSync being called before logging
      // anything
      if (!lastLogger) {
        return null
      }

      if (lastLogger.hasOwnProperty(parsedChindingsSym)) {
        chindings = lastLogger[parsedChindingsSym]
      } else {
        chindings = JSON.parse('{' + lastLogger[chindingsSym].substr(1) + '}')
        lastLogger[parsedChindingsSym] = chindings
      }

      return chindings
    },
    write (chunk) {
      const lastLogger = this.lastLogger
      const chindings = this.chindings()

      let time = this.lastTime

      /* istanbul ignore next */
      if (typeof time === 'number') {
        // do nothing!
      } else if (time.match(/^\d+/)) {
        time = parseInt(time)
      } else {
        time = time.slice(1, -1)
      }

      const lastObj = this.lastObj
      const lastMsg = this.lastMsg
      const errorProps = null

      const formatters = lastLogger[formattersSym]
      const formattedObj = formatters.log ? formatters.log(lastObj) : lastObj

      const messageKey = lastLogger[messageKeySym]
      if (lastMsg && formattedObj && !Object.prototype.hasOwnProperty.call(formattedObj, messageKey)) {
        formattedObj[messageKey] = lastMsg
      }

      const obj = Object.assign({
        level: this.lastLevel,
        time
      }, formattedObj, errorProps)

      const serializers = lastLogger[serializersSym]
      const keys = Object.keys(serializers)

      for (var i = 0; i < keys.length; i++) {
        const key = keys[i]
        if (obj[key] !== undefined) {
          obj[key] = serializers[key](obj[key])
        }
      }

      for (const key in chindings) {
        if (!obj.hasOwnProperty(key)) {
          obj[key] = chindings[key]
        }
      }

      const stringifiers = lastLogger[stringifiersSym]
      const redact = stringifiers[redactFmtSym]

      const formatted = pretty(typeof redact === 'function' ? redact(obj) : obj)
      if (formatted === undefined) return

      setMetadataProps(dest, this)
      dest.write(formatted)
    }
  }
}

function hasBeenTampered (stream) {
  return stream.write !== stream.constructor.prototype.write
}

function buildSafeSonicBoom (opts) {
  const stream = new SonicBoom(opts)
  stream.on('error', filterBrokenPipe)
  // if we are sync: false, we must flush on exit
  if (!opts.sync && isMainThread) {
    setupOnExit(stream)
  }
  return stream

  function filterBrokenPipe (err) {
    // TODO verify on Windows
    if (err.code === 'EPIPE') {
      // If we get EPIPE, we should stop logging here
      // however we have no control to the consumer of
      // SonicBoom, so we just overwrite the write method
      stream.write = noop
      stream.end = noop
      stream.flushSync = noop
      stream.destroy = noop
      return
    }
    stream.removeListener('error', filterBrokenPipe)
    stream.emit('error', err)
  }
}

function setupOnExit (stream) {
  /* istanbul ignore next */
  if (global.WeakRef && global.WeakMap && global.FinalizationRegistry) {
    // This is leak free, it does not leave event handlers
    const onExit = __webpack_require__(46270)

    onExit.register(stream, autoEnd)

    stream.on('close', function () {
      onExit.unregister(stream)
    })
  }
}

function autoEnd (stream, eventName) {
  // This check is needed only on some platforms
  /* istanbul ignore next */
  if (stream.destroyed) {
    return
  }

  if (eventName === 'beforeExit') {
    // We still have an event loop, let's use it
    stream.flush()
    stream.on('drain', function () {
      stream.end()
    })
  } else {
    // We do not have an event loop, so flush synchronously
    stream.flushSync()
  }
}

function createArgsNormalizer (defaultOptions) {
  return function normalizeArgs (instance, caller, opts = {}, stream) {
    // support stream as a string
    if (typeof opts === 'string') {
      stream = buildSafeSonicBoom({ dest: opts, sync: true })
      opts = {}
    } else if (typeof stream === 'string') {
      if (opts && opts.transport) {
        throw Error('only one of option.transport or stream can be specified')
      }
      stream = buildSafeSonicBoom({ dest: stream, sync: true })
    } else if (opts instanceof SonicBoom || opts.writable || opts._writableState) {
      stream = opts
      opts = {}
    } else if (opts.transport) {
      if (opts.transport instanceof SonicBoom || opts.transport.writable || opts.transport._writableState) {
        throw Error('option.transport do not allow stream, please pass to option directly. e.g. pino(transport)')
      }
      if (opts.transport.targets && opts.transport.targets.length && opts.formatters && typeof opts.formatters.level === 'function') {
        throw Error('option.transport.targets do not allow custom level formatters')
      }

      let customLevels
      if (opts.customLevels) {
        customLevels = opts.useOnlyCustomLevels ? opts.customLevels : Object.assign({}, opts.levels, opts.customLevels)
      }
      stream = transport({ caller, ...opts.transport, levels: customLevels })
    }
    opts = Object.assign({}, defaultOptions, opts)
    opts.serializers = Object.assign({}, defaultOptions.serializers, opts.serializers)
    opts.formatters = Object.assign({}, defaultOptions.formatters, opts.formatters)

    if ('onTerminated' in opts) {
      throw Error('The onTerminated option has been removed, use pino.final instead')
    }
    if ('changeLevelName' in opts) {
      process.emitWarning(
        'The changeLevelName option is deprecated and will be removed in v7. Use levelKey instead.',
        { code: 'changeLevelName_deprecation' }
      )
      opts.levelKey = opts.changeLevelName
      delete opts.changeLevelName
    }
    const { enabled, prettyPrint, prettifier, messageKey } = opts
    if (enabled === false) opts.level = 'silent'
    stream = stream || process.stdout
    if (stream === process.stdout && stream.fd >= 0 && !hasBeenTampered(stream)) {
      stream = buildSafeSonicBoom({ fd: stream.fd, sync: true })
    }
    if (prettyPrint) {
      warning.emit('PINODEP008')
      const prettyOpts = Object.assign({ messageKey }, prettyPrint)
      stream = getPrettyStream(prettyOpts, prettifier, stream, instance)
    }
    return { opts, stream }
  }
}

function final (logger, handler) {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 14) warning.emit('PINODEP009')

  if (typeof logger === 'undefined' || typeof logger.child !== 'function') {
    throw Error('expected a pino logger instance')
  }
  const hasHandler = (typeof handler !== 'undefined')
  if (hasHandler && typeof handler !== 'function') {
    throw Error('if supplied, the handler parameter should be a function')
  }
  const stream = logger[streamSym]
  if (typeof stream.flushSync !== 'function') {
    throw Error('final requires a stream that has a flushSync method, such as pino.destination')
  }

  const finalLogger = new Proxy(logger, {
    get: (logger, key) => {
      if (key in logger.levels.values) {
        return (...args) => {
          logger[key](...args)
          stream.flushSync()
        }
      }
      return logger[key]
    }
  })

  if (!hasHandler) {
    try {
      stream.flushSync()
    } catch {
      // it's too late to wait for the stream to be ready
      // because this is a final tick scenario.
      // in practice there shouldn't be a situation where it isn't
      // however, swallow the error just in case (and for easier testing)
    }
    return finalLogger
  }

  return (err = null, ...args) => {
    try {
      stream.flushSync()
    } catch (e) {
      // it's too late to wait for the stream to be ready
      // because this is a final tick scenario.
      // in practice there shouldn't be a situation where it isn't
      // however, swallow the error just in case (and for easier testing)
    }
    return handler(err, finalLogger, ...args)
  }
}

function stringify (obj, stringifySafeFn) {
  try {
    return JSON.stringify(obj)
  } catch (_) {
    try {
      const stringify = stringifySafeFn || this[stringifySafeSym]
      return stringify(obj)
    } catch (_) {
      return '"[unable to serialize, circular reference is too complex to analyze]"'
    }
  }
}

function buildFormatters (level, bindings, log) {
  return {
    level,
    bindings,
    log
  }
}

function setMetadataProps (dest, that) {
  if (dest[needsMetadataGsym] === true) {
    dest.lastLevel = that.lastLevel
    dest.lastMsg = that.lastMsg
    dest.lastObj = that.lastObj
    dest.lastTime = that.lastTime
    dest.lastLogger = that.lastLogger
  }
}

/**
 * Convert a string integer file descriptor to a proper native integer
 * file descriptor.
 *
 * @param {string} destination The file descriptor string to attempt to convert.
 *
 * @returns {Number}
 */
function normalizeDestFileDescriptor (destination) {
  const fd = Number(destination)
  if (typeof destination === 'string' && Number.isFinite(fd)) {
    return fd
  }
  return destination
}

module.exports = {
  noop,
  buildSafeSonicBoom,
  getPrettyStream,
  asChindings,
  asJson,
  genLog,
  createArgsNormalizer,
  final,
  stringify,
  buildFormatters,
  normalizeDestFileDescriptor
}


/***/ }),

/***/ 25146:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const fs = __webpack_require__(79896)
const EventEmitter = __webpack_require__(24434)
const inherits = (__webpack_require__(39023).inherits)
const path = __webpack_require__(16928)
const sleep = __webpack_require__(57814)

const BUSY_WRITE_TIMEOUT = 100

// 16 KB. Don't write more than docker buffer size.
// https://github.com/moby/moby/blob/513ec73831269947d38a644c278ce3cac36783b2/daemon/logger/copier.go#L13
const MAX_WRITE = 16 * 1024

function openFile (file, sonic) {
  sonic._opening = true
  sonic._writing = true
  sonic._asyncDrainScheduled = false

  // NOTE: 'error' and 'ready' events emitted below only relevant when sonic.sync===false
  // for sync mode, there is no way to add a listener that will receive these

  function fileOpened (err, fd) {
    if (err) {
      sonic._reopening = false
      sonic._writing = false
      sonic._opening = false

      if (sonic.sync) {
        process.nextTick(() => {
          if (sonic.listenerCount('error') > 0) {
            sonic.emit('error', err)
          }
        })
      } else {
        sonic.emit('error', err)
      }
      return
    }

    sonic.fd = fd
    sonic.file = file
    sonic._reopening = false
    sonic._opening = false
    sonic._writing = false

    if (sonic.sync) {
      process.nextTick(() => sonic.emit('ready'))
    } else {
      sonic.emit('ready')
    }

    if (sonic._reopening) {
      return
    }

    // start
    if (!sonic._writing && sonic._len > sonic.minLength && !sonic.destroyed) {
      actualWrite(sonic)
    }
  }

  const flags = sonic.append ? 'a' : 'w'
  const mode = sonic.mode

  if (sonic.sync) {
    try {
      if (sonic.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(file, flags, mode)
      fileOpened(null, fd)
    } catch (err) {
      fileOpened(err)
      throw err
    }
  } else if (sonic.mkdir) {
    fs.mkdir(path.dirname(file), { recursive: true }, (err) => {
      if (err) return fileOpened(err)
      fs.open(file, flags, mode, fileOpened)
    })
  } else {
    fs.open(file, flags, mode, fileOpened)
  }
}

function SonicBoom (opts) {
  if (!(this instanceof SonicBoom)) {
    return new SonicBoom(opts)
  }

  let { fd, dest, minLength, maxLength, maxWrite, sync, append = true, mode, mkdir, retryEAGAIN } = opts || {}

  fd = fd || dest

  this._bufs = []
  this._len = 0
  this.fd = -1
  this._writing = false
  this._writingBuf = ''
  this._ending = false
  this._reopening = false
  this._asyncDrainScheduled = false
  this._hwm = Math.max(minLength || 0, 16387)
  this.file = null
  this.destroyed = false
  this.minLength = minLength || 0
  this.maxLength = maxLength || 0
  this.maxWrite = maxWrite || MAX_WRITE
  this.sync = sync || false
  this.append = append || false
  this.mode = mode
  this.retryEAGAIN = retryEAGAIN || (() => true)
  this.mkdir = mkdir || false

  if (typeof fd === 'number') {
    this.fd = fd
    process.nextTick(() => this.emit('ready'))
  } else if (typeof fd === 'string') {
    openFile(fd, this)
  } else {
    throw new Error('SonicBoom supports only file descriptors and files')
  }
  if (this.minLength >= this.maxWrite) {
    throw new Error(`minLength should be smaller than maxWrite (${this.maxWrite})`)
  }

  this.release = (err, n) => {
    if (err) {
      if (err.code === 'EAGAIN' && this.retryEAGAIN(err, this._writingBuf.length, this._len - this._writingBuf.length)) {
        if (this.sync) {
          // This error code should not happen in sync mode, because it is
          // not using the underlining operating system asynchronous functions.
          // However it happens, and so we handle it.
          // Ref: https://github.com/pinojs/pino/issues/783
          try {
            sleep(BUSY_WRITE_TIMEOUT)
            this.release(undefined, 0)
          } catch (err) {
            this.release(err)
          }
        } else {
          // Let's give the destination some time to process the chunk.
          setTimeout(() => {
            fs.write(this.fd, this._writingBuf, 'utf8', this.release)
          }, BUSY_WRITE_TIMEOUT)
        }
      } else {
        this._writing = false

        this.emit('error', err)
      }
      return
    }
    this.emit('write', n)

    this._len -= n
    this._writingBuf = this._writingBuf.slice(n)

    if (this._writingBuf.length) {
      if (!this.sync) {
        fs.write(this.fd, this._writingBuf, 'utf8', this.release)
        return
      }

      try {
        do {
          const n = fs.writeSync(this.fd, this._writingBuf, 'utf8')
          this._len -= n
          this._writingBuf = this._writingBuf.slice(n)
        } while (this._writingBuf)
      } catch (err) {
        this.release(err)
        return
      }
    }

    const len = this._len
    if (this._reopening) {
      this._writing = false
      this._reopening = false
      this.reopen()
    } else if (len > this.minLength) {
      actualWrite(this)
    } else if (this._ending) {
      if (len > 0) {
        actualWrite(this)
      } else {
        this._writing = false
        actualClose(this)
      }
    } else {
      this._writing = false
      if (this.sync) {
        if (!this._asyncDrainScheduled) {
          this._asyncDrainScheduled = true
          process.nextTick(emitDrain, this)
        }
      } else {
        this.emit('drain')
      }
    }
  }

  this.on('newListener', function (name) {
    if (name === 'drain') {
      this._asyncDrainScheduled = false
    }
  })
}

function emitDrain (sonic) {
  const hasListeners = sonic.listenerCount('drain') > 0
  if (!hasListeners) return
  sonic._asyncDrainScheduled = false
  sonic.emit('drain')
}

inherits(SonicBoom, EventEmitter)

SonicBoom.prototype.write = function (data) {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  const len = this._len + data.length
  const bufs = this._bufs

  if (this.maxLength && len > this.maxLength) {
    this.emit('drop', data)
    return this._len < this._hwm
  }

  if (
    bufs.length === 0 ||
    bufs[bufs.length - 1].length + data.length > this.maxWrite
  ) {
    bufs.push('' + data)
  } else {
    bufs[bufs.length - 1] += data
  }

  this._len = len

  if (!this._writing && this._len >= this.minLength) {
    actualWrite(this)
  }

  return this._len < this._hwm
}

SonicBoom.prototype.flush = function () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this._writing || this.minLength <= 0) {
    return
  }

  if (this._bufs.length === 0) {
    this._bufs.push('')
  }

  actualWrite(this)
}

SonicBoom.prototype.reopen = function (file) {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this._opening) {
    this.once('ready', () => {
      this.reopen(file)
    })
    return
  }

  if (this._ending) {
    return
  }

  if (!this.file) {
    throw new Error('Unable to reopen a file descriptor, you must pass a file to SonicBoom')
  }

  this._reopening = true

  if (this._writing) {
    return
  }

  const fd = this.fd
  this.once('ready', () => {
    if (fd !== this.fd) {
      fs.close(fd, (err) => {
        if (err) {
          return this.emit('error', err)
        }
      })
    }
  })

  openFile(file || this.file, this)
}

SonicBoom.prototype.end = function () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this._opening) {
    this.once('ready', () => {
      this.end()
    })
    return
  }

  if (this._ending) {
    return
  }

  this._ending = true

  if (this._writing) {
    return
  }

  if (this._len > 0 && this.fd >= 0) {
    actualWrite(this)
  } else {
    actualClose(this)
  }
}

SonicBoom.prototype.flushSync = function () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this.fd < 0) {
    throw new Error('sonic boom is not ready yet')
  }

  if (!this._writing && this._writingBuf.length > 0) {
    this._bufs.unshift(this._writingBuf)
    this._writingBuf = ''
  }

  while (this._bufs.length) {
    const buf = this._bufs[0]
    try {
      this._len -= fs.writeSync(this.fd, buf, 'utf8')
      this._bufs.shift()
    } catch (err) {
      if (err.code !== 'EAGAIN' || !this.retryEAGAIN(err, buf.length, this._len - buf.length)) {
        throw err
      }

      sleep(BUSY_WRITE_TIMEOUT)
    }
  }
}

SonicBoom.prototype.destroy = function () {
  if (this.destroyed) {
    return
  }
  actualClose(this)
}

function actualWrite (sonic) {
  const release = sonic.release
  sonic._writing = true
  sonic._writingBuf = sonic._writingBuf || sonic._bufs.shift() || ''

  if (sonic.sync) {
    try {
      const written = fs.writeSync(sonic.fd, sonic._writingBuf, 'utf8')
      release(null, written)
    } catch (err) {
      release(err)
    }
  } else {
    fs.write(sonic.fd, sonic._writingBuf, 'utf8', release)
  }
}

function actualClose (sonic) {
  if (sonic.fd === -1) {
    sonic.once('ready', actualClose.bind(null, sonic))
    return
  }

  sonic.destroyed = true
  sonic._bufs = []

  if (sonic.fd !== 1 && sonic.fd !== 2) {
    fs.close(sonic.fd, done)
  } else {
    setImmediate(done)
  }

  function done (err) {
    if (err) {
      sonic.emit('error', err)
      return
    }

    if (sonic._ending && !sonic._writing) {
      sonic.emit('finish')
    }
    sonic.emit('close')
  }
}

/**
 * These export configurations enable JS and TS developers
 * to consumer SonicBoom in whatever way best suits their needs.
 * Some examples of supported import syntax includes:
 * - `const SonicBoom = require('SonicBoom')`
 * - `const { SonicBoom } = require('SonicBoom')`
 * - `import * as SonicBoom from 'SonicBoom'`
 * - `import { SonicBoom } from 'SonicBoom'`
 * - `import SonicBoom from 'SonicBoom'`
 */
SonicBoom.SonicBoom = SonicBoom
SonicBoom.default = SonicBoom
module.exports = SonicBoom


/***/ }),

/***/ 25682:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const tslib_1 = __webpack_require__(98186);
tslib_1.__exportStar(__webpack_require__(77173), exports);
tslib_1.__exportStar(__webpack_require__(91089), exports);
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 31861:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ONE_YEAR = exports.FOUR_WEEKS = exports.THREE_WEEKS = exports.TWO_WEEKS = exports.ONE_WEEK = exports.THIRTY_DAYS = exports.SEVEN_DAYS = exports.FIVE_DAYS = exports.THREE_DAYS = exports.ONE_DAY = exports.TWENTY_FOUR_HOURS = exports.TWELVE_HOURS = exports.SIX_HOURS = exports.THREE_HOURS = exports.ONE_HOUR = exports.SIXTY_MINUTES = exports.THIRTY_MINUTES = exports.TEN_MINUTES = exports.FIVE_MINUTES = exports.ONE_MINUTE = exports.SIXTY_SECONDS = exports.THIRTY_SECONDS = exports.TEN_SECONDS = exports.FIVE_SECONDS = exports.ONE_SECOND = void 0;
exports.ONE_SECOND = 1;
exports.FIVE_SECONDS = 5;
exports.TEN_SECONDS = 10;
exports.THIRTY_SECONDS = 30;
exports.SIXTY_SECONDS = 60;
exports.ONE_MINUTE = exports.SIXTY_SECONDS;
exports.FIVE_MINUTES = exports.ONE_MINUTE * 5;
exports.TEN_MINUTES = exports.ONE_MINUTE * 10;
exports.THIRTY_MINUTES = exports.ONE_MINUTE * 30;
exports.SIXTY_MINUTES = exports.ONE_MINUTE * 60;
exports.ONE_HOUR = exports.SIXTY_MINUTES;
exports.THREE_HOURS = exports.ONE_HOUR * 3;
exports.SIX_HOURS = exports.ONE_HOUR * 6;
exports.TWELVE_HOURS = exports.ONE_HOUR * 12;
exports.TWENTY_FOUR_HOURS = exports.ONE_HOUR * 24;
exports.ONE_DAY = exports.TWENTY_FOUR_HOURS;
exports.THREE_DAYS = exports.ONE_DAY * 3;
exports.FIVE_DAYS = exports.ONE_DAY * 5;
exports.SEVEN_DAYS = exports.ONE_DAY * 7;
exports.THIRTY_DAYS = exports.ONE_DAY * 30;
exports.ONE_WEEK = exports.SEVEN_DAYS;
exports.TWO_WEEKS = exports.ONE_WEEK * 2;
exports.THREE_WEEKS = exports.ONE_WEEK * 3;
exports.FOUR_WEEKS = exports.ONE_WEEK * 4;
exports.ONE_YEAR = exports.ONE_DAY * 365;
//# sourceMappingURL=time.js.map

/***/ }),

/***/ 33925:
/***/ ((module) => {



module.exports = validator

function validator (opts = {}) {
  const {
    ERR_PATHS_MUST_BE_STRINGS = () => 'fast-redact - Paths must be (non-empty) strings',
    ERR_INVALID_PATH = (s) => `fast-redact – Invalid path (${s})`
  } = opts

  return function validate ({ paths }) {
    paths.forEach((s) => {
      if (typeof s !== 'string') {
        throw Error(ERR_PATHS_MUST_BE_STRINGS())
      }
      try {
        if (/〇/.test(s)) throw Error()
        const expr = (s[0] === '[' ? '' : '.') + s.replace(/^\*/, '〇').replace(/\.\*/g, '.〇').replace(/\[\*\]/g, '[〇]')
        if (/\n|\r|;/.test(expr)) throw Error()
        if (/\/\*/.test(expr)) throw Error()
        /* eslint-disable-next-line */
        Function(`
            'use strict'
            const o = new Proxy({}, { get: () => o, set: () => { throw Error() } });
            const 〇 = null;
            o${expr}
            if ([o${expr}].length !== 1) throw Error()`)()
      } catch (e) {
        throw Error(ERR_INVALID_PATH(s))
      }
    })
  }
}


/***/ }),

/***/ 37214:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const errSerializer = __webpack_require__(43985)
const reqSerializers = __webpack_require__(72802)
const resSerializers = __webpack_require__(84344)

module.exports = {
  err: errSerializer,
  mapHttpRequest: reqSerializers.mapHttpRequest,
  mapHttpResponse: resSerializers.mapHttpResponse,
  req: reqSerializers.reqSerializer,
  res: resSerializers.resSerializer,

  wrapErrorSerializer: function wrapErrorSerializer (customSerializer) {
    if (customSerializer === errSerializer) return customSerializer
    return function wrapErrSerializer (err) {
      return customSerializer(errSerializer(err))
    }
  },

  wrapRequestSerializer: function wrapRequestSerializer (customSerializer) {
    if (customSerializer === reqSerializers.reqSerializer) return customSerializer
    return function wrappedReqSerializer (req) {
      return customSerializer(reqSerializers.reqSerializer(req))
    }
  },

  wrapResponseSerializer: function wrapResponseSerializer (customSerializer) {
    if (customSerializer === resSerializers.resSerializer) return customSerializer
    return function wrappedResSerializer (res) {
      return customSerializer(resSerializers.resSerializer(res))
    }
  }
}


/***/ }),

/***/ 38196:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getLocalStorage = exports.getLocalStorageOrThrow = exports.getCrypto = exports.getCryptoOrThrow = exports.getLocation = exports.getLocationOrThrow = exports.getNavigator = exports.getNavigatorOrThrow = exports.getDocument = exports.getDocumentOrThrow = exports.getFromWindowOrThrow = exports.getFromWindow = void 0;
function getFromWindow(name) {
    let res = undefined;
    if (typeof window !== "undefined" && typeof window[name] !== "undefined") {
        res = window[name];
    }
    return res;
}
exports.getFromWindow = getFromWindow;
function getFromWindowOrThrow(name) {
    const res = getFromWindow(name);
    if (!res) {
        throw new Error(`${name} is not defined in Window`);
    }
    return res;
}
exports.getFromWindowOrThrow = getFromWindowOrThrow;
function getDocumentOrThrow() {
    return getFromWindowOrThrow("document");
}
exports.getDocumentOrThrow = getDocumentOrThrow;
function getDocument() {
    return getFromWindow("document");
}
exports.getDocument = getDocument;
function getNavigatorOrThrow() {
    return getFromWindowOrThrow("navigator");
}
exports.getNavigatorOrThrow = getNavigatorOrThrow;
function getNavigator() {
    return getFromWindow("navigator");
}
exports.getNavigator = getNavigator;
function getLocationOrThrow() {
    return getFromWindowOrThrow("location");
}
exports.getLocationOrThrow = getLocationOrThrow;
function getLocation() {
    return getFromWindow("location");
}
exports.getLocation = getLocation;
function getCryptoOrThrow() {
    return getFromWindowOrThrow("crypto");
}
exports.getCryptoOrThrow = getCryptoOrThrow;
function getCrypto() {
    return getFromWindow("crypto");
}
exports.getCrypto = getCrypto;
function getLocalStorageOrThrow() {
    return getFromWindowOrThrow("localStorage");
}
exports.getLocalStorageOrThrow = getLocalStorageOrThrow;
function getLocalStorage() {
    return getFromWindow("localStorage");
}
exports.getLocalStorage = getLocalStorage;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 39629:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const tslib_1 = __webpack_require__(80584);
tslib_1.__exportStar(__webpack_require__(63093), exports);
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 40351:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const metadata = Symbol.for('pino.metadata')
const { levels } = __webpack_require__(95787)

const defaultLevels = Object.create(levels)
defaultLevels.silent = Infinity

const DEFAULT_INFO_LEVEL = levels.info

function multistream (streamsArray, opts) {
  let counter = 0
  streamsArray = streamsArray || []
  opts = opts || { dedupe: false }

  let levels = defaultLevels
  if (opts.levels && typeof opts.levels === 'object') {
    levels = opts.levels
  }

  const res = {
    write,
    add,
    flushSync,
    end,
    minLevel: 0,
    streams: [],
    clone,
    [metadata]: true
  }

  if (Array.isArray(streamsArray)) {
    streamsArray.forEach(add, res)
  } else {
    add.call(res, streamsArray)
  }

  // clean this object up
  // or it will stay allocated forever
  // as it is closed on the following closures
  streamsArray = null

  return res

  // we can exit early because the streams are ordered by level
  function write (data) {
    let dest
    const level = this.lastLevel
    const { streams } = this
    let stream
    for (let i = 0; i < streams.length; i++) {
      dest = streams[i]
      if (dest.level <= level) {
        stream = dest.stream
        if (stream[metadata]) {
          const { lastTime, lastMsg, lastObj, lastLogger } = this
          stream.lastLevel = level
          stream.lastTime = lastTime
          stream.lastMsg = lastMsg
          stream.lastObj = lastObj
          stream.lastLogger = lastLogger
        }
        if (!opts.dedupe || dest.level === level) {
          stream.write(data)
        }
      } else {
        break
      }
    }
  }

  function flushSync () {
    for (const { stream } of this.streams) {
      if (typeof stream.flushSync === 'function') {
        stream.flushSync()
      }
    }
  }

  function add (dest) {
    if (!dest) {
      return res
    }

    // Check that dest implements either StreamEntry or DestinationStream
    const isStream = typeof dest.write === 'function' || dest.stream
    const stream_ = dest.write ? dest : dest.stream
    // This is necessary to provide a meaningful error message, otherwise it throws somewhere inside write()
    if (!isStream) {
      throw Error('stream object needs to implement either StreamEntry or DestinationStream interface')
    }

    const { streams } = this

    let level
    if (typeof dest.levelVal === 'number') {
      level = dest.levelVal
    } else if (typeof dest.level === 'string') {
      level = levels[dest.level]
    } else if (typeof dest.level === 'number') {
      level = dest.level
    } else {
      level = DEFAULT_INFO_LEVEL
    }

    const dest_ = {
      stream: stream_,
      level,
      levelVal: undefined,
      id: counter++
    }

    streams.unshift(dest_)
    streams.sort(compareByLevel)

    this.minLevel = streams[0].level

    return res
  }

  function end () {
    for (const { stream } of this.streams) {
      if (typeof stream.flushSync === 'function') {
        stream.flushSync()
      }
      stream.end()
    }
  }

  function clone (level) {
    const streams = new Array(this.streams.length)

    for (let i = 0; i < streams.length; i++) {
      streams[i] = {
        level: level,
        stream: this.streams[i].stream
      }
    }

    return {
      write,
      add,
      minLevel: level,
      streams,
      clone,
      flushSync,
      [metadata]: true
    }
  }
}

function compareByLevel (a, b) {
  return a.level - b.level
}

module.exports = multistream


/***/ }),

/***/ 40793:
/***/ ((module) => {


function tryStringify (o) {
  try { return JSON.stringify(o) } catch(e) { return '"[Circular]"' }
}

module.exports = format

function format(f, args, opts) {
  var ss = (opts && opts.stringify) || tryStringify
  var offset = 1
  if (typeof f === 'object' && f !== null) {
    var len = args.length + offset
    if (len === 1) return f
    var objects = new Array(len)
    objects[0] = ss(f)
    for (var index = 1; index < len; index++) {
      objects[index] = ss(args[index])
    }
    return objects.join(' ')
  }
  if (typeof f !== 'string') {
    return f
  }
  var argLen = args.length
  if (argLen === 0) return f
  var str = ''
  var a = 1 - offset
  var lastPos = -1
  var flen = (f && f.length) || 0
  for (var i = 0; i < flen;) {
    if (f.charCodeAt(i) === 37 && i + 1 < flen) {
      lastPos = lastPos > -1 ? lastPos : 0
      switch (f.charCodeAt(i + 1)) {
        case 100: // 'd'
        case 102: // 'f'
          if (a >= argLen)
            break
          if (args[a] == null)  break
          if (lastPos < i)
            str += f.slice(lastPos, i)
          str += Number(args[a])
          lastPos = i + 2
          i++
          break
        case 105: // 'i'
          if (a >= argLen)
            break
          if (args[a] == null)  break
          if (lastPos < i)
            str += f.slice(lastPos, i)
          str += Math.floor(Number(args[a]))
          lastPos = i + 2
          i++
          break
        case 79: // 'O'
        case 111: // 'o'
        case 106: // 'j'
          if (a >= argLen)
            break
          if (args[a] === undefined) break
          if (lastPos < i)
            str += f.slice(lastPos, i)
          var type = typeof args[a]
          if (type === 'string') {
            str += '\'' + args[a] + '\''
            lastPos = i + 2
            i++
            break
          }
          if (type === 'function') {
            str += args[a].name || '<anonymous>'
            lastPos = i + 2
            i++
            break
          }
          str += ss(args[a])
          lastPos = i + 2
          i++
          break
        case 115: // 's'
          if (a >= argLen)
            break
          if (lastPos < i)
            str += f.slice(lastPos, i)
          str += String(args[a])
          lastPos = i + 2
          i++
          break
        case 37: // '%'
          if (lastPos < i)
            str += f.slice(lastPos, i)
          str += '%'
          lastPos = i + 2
          i++
          a--
          break
      }
      ++a
    }
    ++i
  }
  if (lastPos === -1)
    return f
  else if (lastPos < flen) {
    str += f.slice(lastPos)
  }

  return str
}


/***/ }),

/***/ 41753:
/***/ ((module) => {



module.exports = /[^.[\]]+|\[((?:.)*?)\]/g

/*
Regular expression explanation:

Alt 1: /[^.[\]]+/ - Match one or more characters that are *not* a dot (.)
                    opening square bracket ([) or closing square bracket (])

Alt 2: /\[((?:.)*?)\]/ - If the char IS dot or square bracket, then create a capture
                         group (which will be capture group $1) that matches anything
                         within square brackets. Expansion is lazy so it will
                         stop matching as soon as the first closing bracket is met `]`
                         (rather than continuing to match until the final closing bracket).
*/


/***/ }),

/***/ 42063:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

var __webpack_unused_export__;

__webpack_unused_export__ = ({ value: true });
exports.g = void 0;
const window_getters_1 = __webpack_require__(38196);
function getWindowMetadata() {
    let doc;
    let loc;
    try {
        doc = window_getters_1.getDocumentOrThrow();
        loc = window_getters_1.getLocationOrThrow();
    }
    catch (e) {
        return null;
    }
    function getIcons() {
        const links = doc.getElementsByTagName("link");
        const icons = [];
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const rel = link.getAttribute("rel");
            if (rel) {
                if (rel.toLowerCase().indexOf("icon") > -1) {
                    const href = link.getAttribute("href");
                    if (href) {
                        if (href.toLowerCase().indexOf("https:") === -1 &&
                            href.toLowerCase().indexOf("http:") === -1 &&
                            href.indexOf("//") !== 0) {
                            let absoluteHref = loc.protocol + "//" + loc.host;
                            if (href.indexOf("/") === 0) {
                                absoluteHref += href;
                            }
                            else {
                                const path = loc.pathname.split("/");
                                path.pop();
                                const finalPath = path.join("/");
                                absoluteHref += finalPath + "/" + href;
                            }
                            icons.push(absoluteHref);
                        }
                        else if (href.indexOf("//") === 0) {
                            const absoluteUrl = loc.protocol + href;
                            icons.push(absoluteUrl);
                        }
                        else {
                            icons.push(href);
                        }
                    }
                }
            }
        }
        return icons;
    }
    function getWindowMetadataOfAny(...args) {
        const metaTags = doc.getElementsByTagName("meta");
        for (let i = 0; i < metaTags.length; i++) {
            const tag = metaTags[i];
            const attributes = ["itemprop", "property", "name"]
                .map((target) => tag.getAttribute(target))
                .filter((attr) => {
                if (attr) {
                    return args.includes(attr);
                }
                return false;
            });
            if (attributes.length && attributes) {
                const content = tag.getAttribute("content");
                if (content) {
                    return content;
                }
            }
        }
        return "";
    }
    function getName() {
        let name = getWindowMetadataOfAny("name", "og:site_name", "og:title", "twitter:title");
        if (!name) {
            name = doc.title;
        }
        return name;
    }
    function getDescription() {
        const description = getWindowMetadataOfAny("description", "og:description", "twitter:description", "keywords");
        return description;
    }
    const name = getName();
    const description = getDescription();
    const url = loc.origin;
    const icons = getIcons();
    const meta = {
        description,
        url,
        icons,
        name,
    };
    return meta;
}
exports.g = getWindowMetadata;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 43713:
/***/ ((module) => {



module.exports = {
  BINARY_TYPES: ['nodebuffer', 'arraybuffer', 'fragments'],
  GUID: '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
  kStatusCode: Symbol('status-code'),
  kWebSocket: Symbol('websocket'),
  EMPTY_BUFFER: Buffer.alloc(0),
  NOOP: () => {}
};


/***/ }),

/***/ 43985:
/***/ ((module) => {



module.exports = errSerializer

const { toString } = Object.prototype
const seen = Symbol('circular-ref-tag')
const rawSymbol = Symbol('pino-raw-err-ref')
const pinoErrProto = Object.create({}, {
  type: {
    enumerable: true,
    writable: true,
    value: undefined
  },
  message: {
    enumerable: true,
    writable: true,
    value: undefined
  },
  stack: {
    enumerable: true,
    writable: true,
    value: undefined
  },
  raw: {
    enumerable: false,
    get: function () {
      return this[rawSymbol]
    },
    set: function (val) {
      this[rawSymbol] = val
    }
  }
})
Object.defineProperty(pinoErrProto, rawSymbol, {
  writable: true,
  value: {}
})

function errSerializer (err) {
  if (!(err instanceof Error)) {
    return err
  }

  err[seen] = undefined // tag to prevent re-looking at this
  const _err = Object.create(pinoErrProto)
  _err.type = toString.call(err.constructor) === '[object Function]'
    ? err.constructor.name
    : err.name
  _err.message = err.message
  _err.stack = err.stack
  for (const key in err) {
    if (_err[key] === undefined) {
      const val = err[key]
      if (val instanceof Error) {
        /* eslint-disable no-prototype-builtins */
        if (!val.hasOwnProperty(seen)) {
          _err[key] = errSerializer(val)
        }
      } else {
        _err[key] = val
      }
    }
  }

  delete err[seen] // clean up tag in case err is serialized again later
  _err.raw = err
  return _err
}


/***/ }),

/***/ 46270:
/***/ ((module) => {



function genWrap (wraps, ref, fn, event) {
  function wrap () {
    const obj = ref.deref()
    // This should alway happen, however GC is
    // undeterministic so it might happen.
    /* istanbul ignore else */
    if (obj !== undefined) {
      fn(obj, event)
    }
  }

  wraps[event] = wrap
  process.once(event, wrap)
}

const registry = new FinalizationRegistry(clear)
const map = new WeakMap()

function clear (wraps) {
  process.removeListener('exit', wraps.exit)
  process.removeListener('beforeExit', wraps.beforeExit)
}

function register (obj, fn) {
  if (obj === undefined) {
    throw new Error('the object can\'t be undefined')
  }
  const ref = new WeakRef(obj)

  const wraps = {}
  map.set(obj, wraps)
  registry.register(obj, wraps)

  genWrap(wraps, ref, fn, 'exit')
  genWrap(wraps, ref, fn, 'beforeExit')
}

function unregister (obj) {
  const wraps = map.get(obj)
  map.delete(obj)
  if (wraps) {
    clear(wraps)
  }
  registry.unregister(obj)
}

module.exports = {
  register,
  unregister
}


/***/ }),

/***/ 48143:
/***/ ((module) => {



const MAX_TIMEOUT = 1000

function wait (state, index, expected, timeout, done) {
  const max = Date.now() + timeout
  let current = Atomics.load(state, index)
  if (current === expected) {
    done(null, 'ok')
    return
  }
  let prior = current
  const check = (backoff) => {
    if (Date.now() > max) {
      done(null, 'timed-out')
    } else {
      setTimeout(() => {
        prior = current
        current = Atomics.load(state, index)
        if (current === prior) {
          check(backoff >= MAX_TIMEOUT ? MAX_TIMEOUT : backoff * 2)
        } else {
          if (current === expected) done(null, 'ok')
          else done(null, 'not-equal')
        }
      }, backoff)
    }
  }
  check(1)
}

// let waitDiffCount = 0
function waitDiff (state, index, expected, timeout, done) {
  // const id = waitDiffCount++
  // process._rawDebug(`>>> waitDiff ${id}`)
  const max = Date.now() + timeout
  let current = Atomics.load(state, index)
  if (current !== expected) {
    done(null, 'ok')
    return
  }
  const check = (backoff) => {
    // process._rawDebug(`${id} ${index} current ${current} expected ${expected}`)
    // process._rawDebug('' + backoff)
    if (Date.now() > max) {
      done(null, 'timed-out')
    } else {
      setTimeout(() => {
        current = Atomics.load(state, index)
        if (current !== expected) {
          done(null, 'ok')
        } else {
          check(backoff >= MAX_TIMEOUT ? MAX_TIMEOUT : backoff * 2)
        }
      }, backoff)
    }
  }
  check(1)
}

module.exports = { wait, waitDiff }


/***/ }),

/***/ 49026:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const tslib_1 = __webpack_require__(80584);
tslib_1.__exportStar(__webpack_require__(79244), exports);
tslib_1.__exportStar(__webpack_require__(31861), exports);
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 53550:
/***/ ((module) => {

module.exports = /*#__PURE__*/JSON.parse('{"name":"pino","version":"7.11.0","description":"super fast, all natural json logger","main":"pino.js","type":"commonjs","types":"pino.d.ts","browser":"./browser.js","files":["pino.js","file.js","pino.d.ts","bin.js","browser.js","pretty.js","usage.txt","test","docs","example.js","lib"],"scripts":{"docs":"docsify serve","browser-test":"airtap --local 8080 test/browser*test.js","lint":"eslint .","test":"npm run lint && npm run transpile && tap --ts && jest test/jest && npm run test-types","test-ci":"npm run lint && npm run transpile && tap --ts --no-check-coverage --coverage-report=lcovonly && npm run test-types","test-ci-pnpm":"pnpm run lint && npm run transpile && tap --ts --no-coverage --no-check-coverage && pnpm run test-types","test-ci-yarn-pnp":"yarn run lint && npm run transpile && tap --ts --no-check-coverage --coverage-report=lcovonly","test-types":"tsc && tsd && ts-node test/types/pino.ts","transpile":"node ./test/fixtures/ts/transpile.cjs","cov-ui":"tap --ts --coverage-report=html","bench":"node benchmarks/utils/runbench all","bench-basic":"node benchmarks/utils/runbench basic","bench-object":"node benchmarks/utils/runbench object","bench-deep-object":"node benchmarks/utils/runbench deep-object","bench-multi-arg":"node benchmarks/utils/runbench multi-arg","bench-longs-tring":"node benchmarks/utils/runbench long-string","bench-child":"node benchmarks/utils/runbench child","bench-child-child":"node benchmarks/utils/runbench child-child","bench-child-creation":"node benchmarks/utils/runbench child-creation","bench-formatters":"node benchmarks/utils/runbench formatters","update-bench-doc":"node benchmarks/utils/generate-benchmark-doc > docs/benchmarks.md"},"bin":{"pino":"./bin.js"},"precommit":"test","repository":{"type":"git","url":"git+https://github.com/pinojs/pino.git"},"keywords":["fast","logger","stream","json"],"author":"Matteo Collina <hello@matteocollina.com>","contributors":["David Mark Clements <huperekchuno@googlemail.com>","James Sumners <james.sumners@gmail.com>","Thomas Watson Steen <w@tson.dk> (https://twitter.com/wa7son)"],"license":"MIT","bugs":{"url":"https://github.com/pinojs/pino/issues"},"homepage":"http://getpino.io","devDependencies":{"@types/flush-write-stream":"^1.0.0","@types/node":"^17.0.0","@types/tap":"^15.0.6","airtap":"4.0.4","benchmark":"^2.1.4","bole":"^4.0.0","bunyan":"^1.8.14","docsify-cli":"^4.4.1","eslint":"^7.17.0","eslint-config-standard":"^16.0.3","eslint-plugin-import":"^2.22.1","eslint-plugin-node":"^11.1.0","eslint-plugin-promise":"^5.1.0","execa":"^5.0.0","fastbench":"^1.0.1","flush-write-stream":"^2.0.0","import-fresh":"^3.2.1","jest":"^27.3.1","log":"^6.0.0","loglevel":"^1.6.7","pino-pretty":"^v7.6.0","pre-commit":"^1.2.2","proxyquire":"^2.1.3","pump":"^3.0.0","rimraf":"^3.0.2","semver":"^7.0.0","split2":"^4.0.0","steed":"^1.1.3","strip-ansi":"^6.0.0","tap":"^16.0.0","tape":"^5.0.0","through2":"^4.0.0","ts-node":"^10.7.0","tsd":"^0.20.0","typescript":"^4.4.4","winston":"^3.3.3"},"dependencies":{"atomic-sleep":"^1.0.0","fast-redact":"^3.0.0","on-exit-leak-free":"^0.2.0","pino-abstract-transport":"v0.5.0","pino-std-serializers":"^4.0.0","process-warning":"^1.0.0","quick-format-unescaped":"^4.0.3","real-require":"^0.1.0","safe-stable-stringify":"^2.1.0","sonic-boom":"^2.2.1","thread-stream":"^0.15.1"},"tsd":{"directory":"test/types"}}');

/***/ }),

/***/ 54811:
/***/ ((module) => {



function noOpPrepareStackTrace (_, stack) {
  return stack
}

module.exports = function getCallers () {
  const originalPrepare = Error.prepareStackTrace
  Error.prepareStackTrace = noOpPrepareStackTrace
  const stack = new Error().stack
  Error.prepareStackTrace = originalPrepare

  if (!Array.isArray(stack)) {
    return undefined
  }

  const entries = stack.slice(2)

  const fileNames = []

  for (const entry of entries) {
    if (!entry) {
      continue
    }

    fileNames.push(entry.getFileName())
  }

  return fileNames
}


/***/ }),

/***/ 57784:
/***/ ((module) => {



const WRITE_INDEX = 4
const READ_INDEX = 8

module.exports = {
  WRITE_INDEX,
  READ_INDEX
}


/***/ }),

/***/ 57814:
/***/ ((module) => {



/* global SharedArrayBuffer, Atomics */

if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
  const nil = new Int32Array(new SharedArrayBuffer(4))

  function sleep (ms) {
    // also filters out NaN, non-number types, including empty strings, but allows bigints
    const valid = ms > 0 && ms < Infinity 
    if (valid === false) {
      if (typeof ms !== 'number' && typeof ms !== 'bigint') {
        throw TypeError('sleep: ms must be a number')
      }
      throw RangeError('sleep: ms must be a number that is greater than 0 but less than Infinity')
    }

    Atomics.wait(nil, 0, 0, Number(ms))
  }
  module.exports = sleep
} else {

  function sleep (ms) {
    // also filters out NaN, non-number types, including empty strings, but allows bigints
    const valid = ms > 0 && ms < Infinity 
    if (valid === false) {
      if (typeof ms !== 'number' && typeof ms !== 'bigint') {
        throw TypeError('sleep: ms must be a number')
      }
      throw RangeError('sleep: ms must be a number that is greater than 0 but less than Infinity')
    }
    const target = Date.now() + Number(ms)
    while (target > Date.now()){}
  }

  module.exports = sleep

}


/***/ }),

/***/ 59348:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { EventEmitter } = __webpack_require__(24434)
const { Worker } = __webpack_require__(28167)
const { join } = __webpack_require__(16928)
const { pathToFileURL } = __webpack_require__(87016)
const { wait } = __webpack_require__(48143)
const {
  WRITE_INDEX,
  READ_INDEX
} = __webpack_require__(57784)
const buffer = __webpack_require__(20181)
const assert = __webpack_require__(42613)

const kImpl = Symbol('kImpl')

// V8 limit for string size
const MAX_STRING = buffer.constants.MAX_STRING_LENGTH

class FakeWeakRef {
  constructor (value) {
    this._value = value
  }

  deref () {
    return this._value
  }
}

const FinalizationRegistry = global.FinalizationRegistry || class FakeFinalizationRegistry {
  register () {}
  unregister () {}
}

const WeakRef = global.WeakRef || FakeWeakRef

const registry = new FinalizationRegistry((worker) => {
  if (worker.exited) {
    return
  }
  worker.terminate()
})

function createWorker (stream, opts) {
  const { filename, workerData } = opts

  const bundlerOverrides = '__bundlerPathsOverrides' in globalThis ? globalThis.__bundlerPathsOverrides : {}
  const toExecute = bundlerOverrides['thread-stream-worker'] || join(__dirname, 'lib', 'worker.js')

  const worker = new Worker(toExecute, {
    ...opts.workerOpts,
    workerData: {
      filename: filename.indexOf('file://') === 0
        ? filename
        : pathToFileURL(filename).href,
      dataBuf: stream[kImpl].dataBuf,
      stateBuf: stream[kImpl].stateBuf,
      workerData
    }
  })

  // We keep a strong reference for now,
  // we need to start writing first
  worker.stream = new FakeWeakRef(stream)

  worker.on('message', onWorkerMessage)
  worker.on('exit', onWorkerExit)
  registry.register(stream, worker)

  return worker
}

function drain (stream) {
  assert(!stream[kImpl].sync)
  if (stream[kImpl].needDrain) {
    stream[kImpl].needDrain = false
    stream.emit('drain')
  }
}

function nextFlush (stream) {
  const writeIndex = Atomics.load(stream[kImpl].state, WRITE_INDEX)
  let leftover = stream[kImpl].data.length - writeIndex

  if (leftover > 0) {
    if (stream[kImpl].buf.length === 0) {
      stream[kImpl].flushing = false

      if (stream[kImpl].ending) {
        end(stream)
      } else if (stream[kImpl].needDrain) {
        process.nextTick(drain, stream)
      }

      return
    }

    let toWrite = stream[kImpl].buf.slice(0, leftover)
    let toWriteBytes = Buffer.byteLength(toWrite)
    if (toWriteBytes <= leftover) {
      stream[kImpl].buf = stream[kImpl].buf.slice(leftover)
      // process._rawDebug('writing ' + toWrite.length)
      write(stream, toWrite, nextFlush.bind(null, stream))
    } else {
      // multi-byte utf-8
      stream.flush(() => {
        // err is already handled in flush()
        if (stream.destroyed) {
          return
        }

        Atomics.store(stream[kImpl].state, READ_INDEX, 0)
        Atomics.store(stream[kImpl].state, WRITE_INDEX, 0)

        // Find a toWrite length that fits the buffer
        // it must exists as the buffer is at least 4 bytes length
        // and the max utf-8 length for a char is 4 bytes.
        while (toWriteBytes > stream[kImpl].data.length) {
          leftover = leftover / 2
          toWrite = stream[kImpl].buf.slice(0, leftover)
          toWriteBytes = Buffer.byteLength(toWrite)
        }
        stream[kImpl].buf = stream[kImpl].buf.slice(leftover)
        write(stream, toWrite, nextFlush.bind(null, stream))
      })
    }
  } else if (leftover === 0) {
    if (writeIndex === 0 && stream[kImpl].buf.length === 0) {
      // we had a flushSync in the meanwhile
      return
    }
    stream.flush(() => {
      Atomics.store(stream[kImpl].state, READ_INDEX, 0)
      Atomics.store(stream[kImpl].state, WRITE_INDEX, 0)
      nextFlush(stream)
    })
  } else {
    // This should never happen
    throw new Error('overwritten')
  }
}

function onWorkerMessage (msg) {
  const stream = this.stream.deref()
  if (stream === undefined) {
    this.exited = true
    // Terminate the worker.
    this.terminate()
    return
  }

  switch (msg.code) {
    case 'READY':
      // Replace the FakeWeakRef with a
      // proper one.
      this.stream = new WeakRef(stream)

      stream.flush(() => {
        stream[kImpl].ready = true
        stream.emit('ready')
      })
      break
    case 'ERROR':
      destroy(stream, msg.err)
      break
    default:
      throw new Error('this should not happen: ' + msg.code)
  }
}

function onWorkerExit (code) {
  const stream = this.stream.deref()
  if (stream === undefined) {
    // Nothing to do, the worker already exit
    return
  }
  registry.unregister(stream)
  stream.worker.exited = true
  stream.worker.off('exit', onWorkerExit)
  destroy(stream, code !== 0 ? new Error('The worker thread exited') : null)
}

class ThreadStream extends EventEmitter {
  constructor (opts = {}) {
    super()

    if (opts.bufferSize < 4) {
      throw new Error('bufferSize must at least fit a 4-byte utf-8 char')
    }

    this[kImpl] = {}
    this[kImpl].stateBuf = new SharedArrayBuffer(128)
    this[kImpl].state = new Int32Array(this[kImpl].stateBuf)
    this[kImpl].dataBuf = new SharedArrayBuffer(opts.bufferSize || 4 * 1024 * 1024)
    this[kImpl].data = Buffer.from(this[kImpl].dataBuf)
    this[kImpl].sync = opts.sync || false
    this[kImpl].ending = false
    this[kImpl].ended = false
    this[kImpl].needDrain = false
    this[kImpl].destroyed = false
    this[kImpl].flushing = false
    this[kImpl].ready = false
    this[kImpl].finished = false
    this[kImpl].errored = null
    this[kImpl].closed = false
    this[kImpl].buf = ''

    // TODO (fix): Make private?
    this.worker = createWorker(this, opts) // TODO (fix): make private
  }

  write (data) {
    if (this[kImpl].destroyed) {
      throw new Error('the worker has exited')
    }

    if (this[kImpl].ending) {
      throw new Error('the worker is ending')
    }

    if (this[kImpl].flushing && this[kImpl].buf.length + data.length >= MAX_STRING) {
      try {
        writeSync(this)
        this[kImpl].flushing = true
      } catch (err) {
        destroy(this, err)
        return false
      }
    }

    this[kImpl].buf += data

    if (this[kImpl].sync) {
      try {
        writeSync(this)
        return true
      } catch (err) {
        destroy(this, err)
        return false
      }
    }

    if (!this[kImpl].flushing) {
      this[kImpl].flushing = true
      setImmediate(nextFlush, this)
    }

    this[kImpl].needDrain = this[kImpl].data.length - this[kImpl].buf.length - Atomics.load(this[kImpl].state, WRITE_INDEX) <= 0
    return !this[kImpl].needDrain
  }

  end () {
    if (this[kImpl].destroyed) {
      return
    }

    this[kImpl].ending = true
    end(this)
  }

  flush (cb) {
    if (this[kImpl].destroyed) {
      if (typeof cb === 'function') {
        process.nextTick(cb, new Error('the worker has exited'))
      }
      return
    }

    // TODO write all .buf
    const writeIndex = Atomics.load(this[kImpl].state, WRITE_INDEX)
    // process._rawDebug(`(flush) readIndex (${Atomics.load(this.state, READ_INDEX)}) writeIndex (${Atomics.load(this.state, WRITE_INDEX)})`)
    wait(this[kImpl].state, READ_INDEX, writeIndex, Infinity, (err, res) => {
      if (err) {
        destroy(this, err)
        process.nextTick(cb, err)
        return
      }
      if (res === 'not-equal') {
        // TODO handle deadlock
        this.flush(cb)
        return
      }
      process.nextTick(cb)
    })
  }

  flushSync () {
    if (this[kImpl].destroyed) {
      return
    }

    writeSync(this)
    flushSync(this)
  }

  unref () {
    this.worker.unref()
  }

  ref () {
    this.worker.ref()
  }

  get ready () {
    return this[kImpl].ready
  }

  get destroyed () {
    return this[kImpl].destroyed
  }

  get closed () {
    return this[kImpl].closed
  }

  get writable () {
    return !this[kImpl].destroyed && !this[kImpl].ending
  }

  get writableEnded () {
    return this[kImpl].ending
  }

  get writableFinished () {
    return this[kImpl].finished
  }

  get writableNeedDrain () {
    return this[kImpl].needDrain
  }

  get writableObjectMode () {
    return false
  }

  get writableErrored () {
    return this[kImpl].errored
  }
}

function destroy (stream, err) {
  if (stream[kImpl].destroyed) {
    return
  }
  stream[kImpl].destroyed = true

  if (err) {
    stream[kImpl].errored = err
    stream.emit('error', err)
  }

  if (!stream.worker.exited) {
    stream.worker.terminate()
      .catch(() => {})
      .then(() => {
        stream[kImpl].closed = true
        stream.emit('close')
      })
  } else {
    setImmediate(() => {
      stream[kImpl].closed = true
      stream.emit('close')
    })
  }
}

function write (stream, data, cb) {
  // data is smaller than the shared buffer length
  const current = Atomics.load(stream[kImpl].state, WRITE_INDEX)
  const length = Buffer.byteLength(data)
  stream[kImpl].data.write(data, current)
  Atomics.store(stream[kImpl].state, WRITE_INDEX, current + length)
  Atomics.notify(stream[kImpl].state, WRITE_INDEX)
  cb()
  return true
}

function end (stream) {
  if (stream[kImpl].ended || !stream[kImpl].ending || stream[kImpl].flushing) {
    return
  }
  stream[kImpl].ended = true

  try {
    stream.flushSync()

    let readIndex = Atomics.load(stream[kImpl].state, READ_INDEX)

    // process._rawDebug('writing index')
    Atomics.store(stream[kImpl].state, WRITE_INDEX, -1)
    // process._rawDebug(`(end) readIndex (${Atomics.load(stream.state, READ_INDEX)}) writeIndex (${Atomics.load(stream.state, WRITE_INDEX)})`)
    Atomics.notify(stream[kImpl].state, WRITE_INDEX)

    // Wait for the process to complete
    let spins = 0
    while (readIndex !== -1) {
      // process._rawDebug(`read = ${read}`)
      Atomics.wait(stream[kImpl].state, READ_INDEX, readIndex, 1000)
      readIndex = Atomics.load(stream[kImpl].state, READ_INDEX)

      if (readIndex === -2) {
        throw new Error('end() failed')
      }

      if (++spins === 10) {
        throw new Error('end() took too long (10s)')
      }
    }

    process.nextTick(() => {
      stream[kImpl].finished = true
      stream.emit('finish')
    })
  } catch (err) {
    destroy(stream, err)
  }
  // process._rawDebug('end finished...')
}

function writeSync (stream) {
  const cb = () => {
    if (stream[kImpl].ending) {
      end(stream)
    } else if (stream[kImpl].needDrain) {
      process.nextTick(drain, stream)
    }
  }
  stream[kImpl].flushing = false

  while (stream[kImpl].buf.length !== 0) {
    const writeIndex = Atomics.load(stream[kImpl].state, WRITE_INDEX)
    let leftover = stream[kImpl].data.length - writeIndex
    if (leftover === 0) {
      flushSync(stream)
      Atomics.store(stream[kImpl].state, READ_INDEX, 0)
      Atomics.store(stream[kImpl].state, WRITE_INDEX, 0)
      continue
    } else if (leftover < 0) {
      // stream should never happen
      throw new Error('overwritten')
    }

    let toWrite = stream[kImpl].buf.slice(0, leftover)
    let toWriteBytes = Buffer.byteLength(toWrite)
    if (toWriteBytes <= leftover) {
      stream[kImpl].buf = stream[kImpl].buf.slice(leftover)
      // process._rawDebug('writing ' + toWrite.length)
      write(stream, toWrite, cb)
    } else {
      // multi-byte utf-8
      flushSync(stream)
      Atomics.store(stream[kImpl].state, READ_INDEX, 0)
      Atomics.store(stream[kImpl].state, WRITE_INDEX, 0)

      // Find a toWrite length that fits the buffer
      // it must exists as the buffer is at least 4 bytes length
      // and the max utf-8 length for a char is 4 bytes.
      while (toWriteBytes > stream[kImpl].buf.length) {
        leftover = leftover / 2
        toWrite = stream[kImpl].buf.slice(0, leftover)
        toWriteBytes = Buffer.byteLength(toWrite)
      }
      stream[kImpl].buf = stream[kImpl].buf.slice(leftover)
      write(stream, toWrite, cb)
    }
  }
}

function flushSync (stream) {
  if (stream[kImpl].flushing) {
    throw new Error('unable to flush while flushing')
  }

  // process._rawDebug('flushSync started')

  const writeIndex = Atomics.load(stream[kImpl].state, WRITE_INDEX)

  let spins = 0

  // TODO handle deadlock
  while (true) {
    const readIndex = Atomics.load(stream[kImpl].state, READ_INDEX)

    if (readIndex === -2) {
      throw new Error('_flushSync failed')
    }

    // process._rawDebug(`(flushSync) readIndex (${readIndex}) writeIndex (${writeIndex})`)
    if (readIndex !== writeIndex) {
      // TODO stream timeouts for some reason.
      Atomics.wait(stream[kImpl].state, READ_INDEX, readIndex, 1000)
    } else {
      break
    }

    if (++spins === 10) {
      throw new Error('_flushSync took too long (10s)')
    }
  }
  // process._rawDebug('flushSync finished')
}

module.exports = ThreadStream


/***/ }),

/***/ 59360:
/***/ ((module) => {



/**
 * Class representing an event.
 *
 * @private
 */
class Event {
  /**
   * Create a new `Event`.
   *
   * @param {String} type The name of the event
   * @param {Object} target A reference to the target to which the event was
   *     dispatched
   */
  constructor(type, target) {
    this.target = target;
    this.type = type;
  }
}

/**
 * Class representing a message event.
 *
 * @extends Event
 * @private
 */
class MessageEvent extends Event {
  /**
   * Create a new `MessageEvent`.
   *
   * @param {(String|Buffer|ArrayBuffer|Buffer[])} data The received data
   * @param {WebSocket} target A reference to the target to which the event was
   *     dispatched
   */
  constructor(data, target) {
    super('message', target);

    this.data = data;
  }
}

/**
 * Class representing a close event.
 *
 * @extends Event
 * @private
 */
class CloseEvent extends Event {
  /**
   * Create a new `CloseEvent`.
   *
   * @param {Number} code The status code explaining why the connection is being
   *     closed
   * @param {String} reason A human-readable string explaining why the
   *     connection is closing
   * @param {WebSocket} target A reference to the target to which the event was
   *     dispatched
   */
  constructor(code, reason, target) {
    super('close', target);

    this.wasClean = target._closeFrameReceived && target._closeFrameSent;
    this.reason = reason;
    this.code = code;
  }
}

/**
 * Class representing an open event.
 *
 * @extends Event
 * @private
 */
class OpenEvent extends Event {
  /**
   * Create a new `OpenEvent`.
   *
   * @param {WebSocket} target A reference to the target to which the event was
   *     dispatched
   */
  constructor(target) {
    super('open', target);
  }
}

/**
 * Class representing an error event.
 *
 * @extends Event
 * @private
 */
class ErrorEvent extends Event {
  /**
   * Create a new `ErrorEvent`.
   *
   * @param {Object} error The error that generated this event
   * @param {WebSocket} target A reference to the target to which the event was
   *     dispatched
   */
  constructor(error, target) {
    super('error', target);

    this.message = error.message;
    this.error = error;
  }
}

/**
 * This provides methods for emulating the `EventTarget` interface. It's not
 * meant to be used directly.
 *
 * @mixin
 */
const EventTarget = {
  /**
   * Register an event listener.
   *
   * @param {String} type A string representing the event type to listen for
   * @param {Function} listener The listener to add
   * @param {Object} [options] An options object specifies characteristics about
   *     the event listener
   * @param {Boolean} [options.once=false] A `Boolean`` indicating that the
   *     listener should be invoked at most once after being added. If `true`,
   *     the listener would be automatically removed when invoked.
   * @public
   */
  addEventListener(type, listener, options) {
    if (typeof listener !== 'function') return;

    function onMessage(data) {
      listener.call(this, new MessageEvent(data, this));
    }

    function onClose(code, message) {
      listener.call(this, new CloseEvent(code, message, this));
    }

    function onError(error) {
      listener.call(this, new ErrorEvent(error, this));
    }

    function onOpen() {
      listener.call(this, new OpenEvent(this));
    }

    const method = options && options.once ? 'once' : 'on';

    if (type === 'message') {
      onMessage._listener = listener;
      this[method](type, onMessage);
    } else if (type === 'close') {
      onClose._listener = listener;
      this[method](type, onClose);
    } else if (type === 'error') {
      onError._listener = listener;
      this[method](type, onError);
    } else if (type === 'open') {
      onOpen._listener = listener;
      this[method](type, onOpen);
    } else {
      this[method](type, listener);
    }
  },

  /**
   * Remove an event listener.
   *
   * @param {String} type A string representing the event type to remove
   * @param {Function} listener The listener to remove
   * @public
   */
  removeEventListener(type, listener) {
    const listeners = this.listeners(type);

    for (let i = 0; i < listeners.length; i++) {
      if (listeners[i] === listener || listeners[i]._listener === listener) {
        this.removeListener(type, listeners[i]);
      }
    }
  }
};

module.exports = EventTarget;


/***/ }),

/***/ 60221:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.fromMiliseconds = exports.toMiliseconds = void 0;
const constants_1 = __webpack_require__(49026);
function toMiliseconds(seconds) {
    return seconds * constants_1.ONE_THOUSAND;
}
exports.toMiliseconds = toMiliseconds;
function fromMiliseconds(miliseconds) {
    return Math.floor(miliseconds / constants_1.ONE_THOUSAND);
}
exports.fromMiliseconds = fromMiliseconds;
//# sourceMappingURL=convert.js.map

/***/ }),

/***/ 63093:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.IWatch = void 0;
class IWatch {
}
exports.IWatch = IWatch;
//# sourceMappingURL=watch.js.map

/***/ }),

/***/ 65177:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



/**
 * Checks if a status code is allowed in a close frame.
 *
 * @param {Number} code The status code
 * @return {Boolean} `true` if the status code is valid, else `false`
 * @public
 */
function isValidStatusCode(code) {
  return (
    (code >= 1000 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

/**
 * Checks if a given buffer contains only correct UTF-8.
 * Ported from https://www.cl.cam.ac.uk/%7Emgk25/ucs/utf8_check.c by
 * Markus Kuhn.
 *
 * @param {Buffer} buf The buffer to check
 * @return {Boolean} `true` if `buf` contains only correct UTF-8, else `false`
 * @public
 */
function _isValidUTF8(buf) {
  const len = buf.length;
  let i = 0;

  while (i < len) {
    if ((buf[i] & 0x80) === 0) {
      // 0xxxxxxx
      i++;
    } else if ((buf[i] & 0xe0) === 0xc0) {
      // 110xxxxx 10xxxxxx
      if (
        i + 1 === len ||
        (buf[i + 1] & 0xc0) !== 0x80 ||
        (buf[i] & 0xfe) === 0xc0 // Overlong
      ) {
        return false;
      }

      i += 2;
    } else if ((buf[i] & 0xf0) === 0xe0) {
      // 1110xxxx 10xxxxxx 10xxxxxx
      if (
        i + 2 >= len ||
        (buf[i + 1] & 0xc0) !== 0x80 ||
        (buf[i + 2] & 0xc0) !== 0x80 ||
        (buf[i] === 0xe0 && (buf[i + 1] & 0xe0) === 0x80) || // Overlong
        (buf[i] === 0xed && (buf[i + 1] & 0xe0) === 0xa0) // Surrogate (U+D800 - U+DFFF)
      ) {
        return false;
      }

      i += 3;
    } else if ((buf[i] & 0xf8) === 0xf0) {
      // 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
      if (
        i + 3 >= len ||
        (buf[i + 1] & 0xc0) !== 0x80 ||
        (buf[i + 2] & 0xc0) !== 0x80 ||
        (buf[i + 3] & 0xc0) !== 0x80 ||
        (buf[i] === 0xf0 && (buf[i + 1] & 0xf0) === 0x80) || // Overlong
        (buf[i] === 0xf4 && buf[i + 1] > 0x8f) ||
        buf[i] > 0xf4 // > U+10FFFF
      ) {
        return false;
      }

      i += 4;
    } else {
      return false;
    }
  }

  return true;
}

try {
  let isValidUTF8 = __webpack_require__(Object(function webpackMissingModule() { var e = new Error("Cannot find module 'utf-8-validate'"); e.code = 'MODULE_NOT_FOUND'; throw e; }()));

  /* istanbul ignore if */
  if (typeof isValidUTF8 === 'object') {
    isValidUTF8 = isValidUTF8.Validation.isValidUTF8; // utf-8-validate@<3.0.0
  }

  module.exports = {
    isValidStatusCode,
    isValidUTF8(buf) {
      return buf.length < 150 ? _isValidUTF8(buf) : isValidUTF8(buf);
    }
  };
} catch (e) /* istanbul ignore next */ {
  module.exports = {
    isValidStatusCode,
    isValidUTF8: _isValidUTF8
  };
}


/***/ }),

/***/ 65835:
/***/ ((module) => {



const setLevelSym = Symbol('pino.setLevel')
const getLevelSym = Symbol('pino.getLevel')
const levelValSym = Symbol('pino.levelVal')
const useLevelLabelsSym = Symbol('pino.useLevelLabels')
const useOnlyCustomLevelsSym = Symbol('pino.useOnlyCustomLevels')
const mixinSym = Symbol('pino.mixin')

const lsCacheSym = Symbol('pino.lsCache')
const chindingsSym = Symbol('pino.chindings')
const parsedChindingsSym = Symbol('pino.parsedChindings')

const asJsonSym = Symbol('pino.asJson')
const writeSym = Symbol('pino.write')
const redactFmtSym = Symbol('pino.redactFmt')

const timeSym = Symbol('pino.time')
const timeSliceIndexSym = Symbol('pino.timeSliceIndex')
const streamSym = Symbol('pino.stream')
const stringifySym = Symbol('pino.stringify')
const stringifySafeSym = Symbol('pino.stringifySafe')
const stringifiersSym = Symbol('pino.stringifiers')
const endSym = Symbol('pino.end')
const formatOptsSym = Symbol('pino.formatOpts')
const messageKeySym = Symbol('pino.messageKey')
const nestedKeySym = Symbol('pino.nestedKey')
const nestedKeyStrSym = Symbol('pino.nestedKeyStr')
const mixinMergeStrategySym = Symbol('pino.mixinMergeStrategy')

const wildcardFirstSym = Symbol('pino.wildcardFirst')

// public symbols, no need to use the same pino
// version for these
const serializersSym = Symbol.for('pino.serializers')
const formattersSym = Symbol.for('pino.formatters')
const hooksSym = Symbol.for('pino.hooks')
const needsMetadataGsym = Symbol.for('pino.metadata')

module.exports = {
  setLevelSym,
  getLevelSym,
  levelValSym,
  useLevelLabelsSym,
  mixinSym,
  lsCacheSym,
  chindingsSym,
  parsedChindingsSym,
  asJsonSym,
  writeSym,
  serializersSym,
  redactFmtSym,
  timeSym,
  timeSliceIndexSym,
  streamSym,
  stringifySym,
  stringifySafeSym,
  stringifiersSym,
  endSym,
  formatOptsSym,
  messageKeySym,
  nestedKeySym,
  wildcardFirstSym,
  needsMetadataGsym,
  useOnlyCustomLevelsSym,
  formattersSym,
  hooksSym,
  nestedKeyStrSym,
  mixinMergeStrategySym
}


/***/ }),

/***/ 66853:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { version } = __webpack_require__(53550)

module.exports = { version }


/***/ }),

/***/ 70824:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



/* eslint no-prototype-builtins: 0 */

const { EventEmitter } = __webpack_require__(24434)
const {
  lsCacheSym,
  levelValSym,
  setLevelSym,
  getLevelSym,
  chindingsSym,
  parsedChindingsSym,
  mixinSym,
  asJsonSym,
  writeSym,
  mixinMergeStrategySym,
  timeSym,
  timeSliceIndexSym,
  streamSym,
  serializersSym,
  formattersSym,
  useOnlyCustomLevelsSym,
  needsMetadataGsym,
  redactFmtSym,
  stringifySym,
  formatOptsSym,
  stringifiersSym
} = __webpack_require__(65835)
const {
  getLevel,
  setLevel,
  isLevelEnabled,
  mappings,
  initialLsCache,
  genLsCache,
  assertNoLevelCollisions
} = __webpack_require__(95787)
const {
  asChindings,
  asJson,
  buildFormatters,
  stringify
} = __webpack_require__(16761)
const {
  version
} = __webpack_require__(66853)
const redaction = __webpack_require__(4123)

// note: use of class is satirical
// https://github.com/pinojs/pino/pull/433#pullrequestreview-127703127
const constructor = class Pino {}
const prototype = {
  constructor,
  child,
  bindings,
  setBindings,
  flush,
  isLevelEnabled,
  version,
  get level () { return this[getLevelSym]() },
  set level (lvl) { this[setLevelSym](lvl) },
  get levelVal () { return this[levelValSym] },
  set levelVal (n) { throw Error('levelVal is read-only') },
  [lsCacheSym]: initialLsCache,
  [writeSym]: write,
  [asJsonSym]: asJson,
  [getLevelSym]: getLevel,
  [setLevelSym]: setLevel
}

Object.setPrototypeOf(prototype, EventEmitter.prototype)

// exporting and consuming the prototype object using factory pattern fixes scoping issues with getters when serializing
module.exports = function () {
  return Object.create(prototype)
}

const resetChildingsFormatter = bindings => bindings
function child (bindings, options) {
  if (!bindings) {
    throw Error('missing bindings for child Pino')
  }
  options = options || {} // default options to empty object
  const serializers = this[serializersSym]
  const formatters = this[formattersSym]
  const instance = Object.create(this)

  if (options.hasOwnProperty('serializers') === true) {
    instance[serializersSym] = Object.create(null)

    for (const k in serializers) {
      instance[serializersSym][k] = serializers[k]
    }
    const parentSymbols = Object.getOwnPropertySymbols(serializers)
    /* eslint no-var: off */
    for (var i = 0; i < parentSymbols.length; i++) {
      const ks = parentSymbols[i]
      instance[serializersSym][ks] = serializers[ks]
    }

    for (const bk in options.serializers) {
      instance[serializersSym][bk] = options.serializers[bk]
    }
    const bindingsSymbols = Object.getOwnPropertySymbols(options.serializers)
    for (var bi = 0; bi < bindingsSymbols.length; bi++) {
      const bks = bindingsSymbols[bi]
      instance[serializersSym][bks] = options.serializers[bks]
    }
  } else instance[serializersSym] = serializers
  if (options.hasOwnProperty('formatters')) {
    const { level, bindings: chindings, log } = options.formatters
    instance[formattersSym] = buildFormatters(
      level || formatters.level,
      chindings || resetChildingsFormatter,
      log || formatters.log
    )
  } else {
    instance[formattersSym] = buildFormatters(
      formatters.level,
      resetChildingsFormatter,
      formatters.log
    )
  }
  if (options.hasOwnProperty('customLevels') === true) {
    assertNoLevelCollisions(this.levels, options.customLevels)
    instance.levels = mappings(options.customLevels, instance[useOnlyCustomLevelsSym])
    genLsCache(instance)
  }

  // redact must place before asChindings and only replace if exist
  if ((typeof options.redact === 'object' && options.redact !== null) || Array.isArray(options.redact)) {
    instance.redact = options.redact // replace redact directly
    const stringifiers = redaction(instance.redact, stringify)
    const formatOpts = { stringify: stringifiers[redactFmtSym] }
    instance[stringifySym] = stringify
    instance[stringifiersSym] = stringifiers
    instance[formatOptsSym] = formatOpts
  }

  instance[chindingsSym] = asChindings(instance, bindings)
  const childLevel = options.level || this.level
  instance[setLevelSym](childLevel)

  return instance
}

function bindings () {
  const chindings = this[chindingsSym]
  const chindingsJson = `{${chindings.substr(1)}}` // at least contains ,"pid":7068,"hostname":"myMac"
  const bindingsFromJson = JSON.parse(chindingsJson)
  delete bindingsFromJson.pid
  delete bindingsFromJson.hostname
  return bindingsFromJson
}

function setBindings (newBindings) {
  const chindings = asChindings(this, newBindings)
  this[chindingsSym] = chindings
  delete this[parsedChindingsSym]
}

/**
 * Default strategy for creating `mergeObject` from arguments and the result from `mixin()`.
 * Fields from `mergeObject` have higher priority in this strategy.
 *
 * @param {Object} mergeObject The object a user has supplied to the logging function.
 * @param {Object} mixinObject The result of the `mixin` method.
 * @return {Object}
 */
function defaultMixinMergeStrategy (mergeObject, mixinObject) {
  return Object.assign(mixinObject, mergeObject)
}

function write (_obj, msg, num) {
  const t = this[timeSym]()
  const mixin = this[mixinSym]
  const mixinMergeStrategy = this[mixinMergeStrategySym] || defaultMixinMergeStrategy
  let obj

  if (_obj === undefined || _obj === null) {
    obj = {}
  } else if (_obj instanceof Error) {
    obj = { err: _obj }
    if (msg === undefined) {
      msg = _obj.message
    }
  } else {
    obj = _obj
    if (msg === undefined && _obj.err) {
      msg = _obj.err.message
    }
  }

  if (mixin) {
    obj = mixinMergeStrategy(obj, mixin(obj, num))
  }

  const s = this[asJsonSym](obj, msg, num, t)

  const stream = this[streamSym]
  if (stream[needsMetadataGsym] === true) {
    stream.lastLevel = num
    stream.lastObj = obj
    stream.lastMsg = msg
    stream.lastTime = t.slice(this[timeSliceIndexSym])
    stream.lastLogger = this // for child loggers
  }
  stream.write(s)
}

function noop () {}

function flush () {
  const stream = this[streamSym]
  if ('flush' in stream) stream.flush(noop)
}


/***/ }),

/***/ 72802:
/***/ ((module) => {



module.exports = {
  mapHttpRequest,
  reqSerializer
}

const rawSymbol = Symbol('pino-raw-req-ref')
const pinoReqProto = Object.create({}, {
  id: {
    enumerable: true,
    writable: true,
    value: ''
  },
  method: {
    enumerable: true,
    writable: true,
    value: ''
  },
  url: {
    enumerable: true,
    writable: true,
    value: ''
  },
  query: {
    enumerable: true,
    writable: true,
    value: ''
  },
  params: {
    enumerable: true,
    writable: true,
    value: ''
  },
  headers: {
    enumerable: true,
    writable: true,
    value: {}
  },
  remoteAddress: {
    enumerable: true,
    writable: true,
    value: ''
  },
  remotePort: {
    enumerable: true,
    writable: true,
    value: ''
  },
  raw: {
    enumerable: false,
    get: function () {
      return this[rawSymbol]
    },
    set: function (val) {
      this[rawSymbol] = val
    }
  }
})
Object.defineProperty(pinoReqProto, rawSymbol, {
  writable: true,
  value: {}
})

function reqSerializer (req) {
  // req.info is for hapi compat.
  const connection = req.info || req.socket
  const _req = Object.create(pinoReqProto)
  _req.id = (typeof req.id === 'function' ? req.id() : (req.id || (req.info ? req.info.id : undefined)))
  _req.method = req.method
  // req.originalUrl is for expressjs compat.
  if (req.originalUrl) {
    _req.url = req.originalUrl
    _req.query = req.query
    _req.params = req.params
  } else {
    // req.url.path is  for hapi compat.
    _req.url = req.path || (req.url ? (req.url.path || req.url) : undefined)
  }
  _req.headers = req.headers
  _req.remoteAddress = connection && connection.remoteAddress
  _req.remotePort = connection && connection.remotePort
  // req.raw is  for hapi compat/equivalence
  _req.raw = req.raw || req
  return _req
}

function mapHttpRequest (req) {
  return {
    req: reqSerializer(req)
  }
}


/***/ }),

/***/ 74452:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const warning = __webpack_require__(6187)()
module.exports = warning

const warnName = 'PinoWarning'

warning.create(warnName, 'PINODEP008', 'prettyPrint is deprecated, look at https://github.com/pinojs/pino-pretty for alternatives.')

warning.create(warnName, 'PINODEP009', 'The use of pino.final is discouraged in Node.js v14+ and not required. It will be removed in the next major version')


/***/ }),

/***/ 74722:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { Duplex } = __webpack_require__(2203);

/**
 * Emits the `'close'` event on a stream.
 *
 * @param {Duplex} stream The stream.
 * @private
 */
function emitClose(stream) {
  stream.emit('close');
}

/**
 * The listener of the `'end'` event.
 *
 * @private
 */
function duplexOnEnd() {
  if (!this.destroyed && this._writableState.finished) {
    this.destroy();
  }
}

/**
 * The listener of the `'error'` event.
 *
 * @param {Error} err The error
 * @private
 */
function duplexOnError(err) {
  this.removeListener('error', duplexOnError);
  this.destroy();
  if (this.listenerCount('error') === 0) {
    // Do not suppress the throwing behavior.
    this.emit('error', err);
  }
}

/**
 * Wraps a `WebSocket` in a duplex stream.
 *
 * @param {WebSocket} ws The `WebSocket` to wrap
 * @param {Object} [options] The options for the `Duplex` constructor
 * @return {Duplex} The duplex stream
 * @public
 */
function createWebSocketStream(ws, options) {
  let resumeOnReceiverDrain = true;
  let terminateOnDestroy = true;

  function receiverOnDrain() {
    if (resumeOnReceiverDrain) ws._socket.resume();
  }

  if (ws.readyState === ws.CONNECTING) {
    ws.once('open', function open() {
      ws._receiver.removeAllListeners('drain');
      ws._receiver.on('drain', receiverOnDrain);
    });
  } else {
    ws._receiver.removeAllListeners('drain');
    ws._receiver.on('drain', receiverOnDrain);
  }

  const duplex = new Duplex({
    ...options,
    autoDestroy: false,
    emitClose: false,
    objectMode: false,
    writableObjectMode: false
  });

  ws.on('message', function message(msg) {
    if (!duplex.push(msg)) {
      resumeOnReceiverDrain = false;
      ws._socket.pause();
    }
  });

  ws.once('error', function error(err) {
    if (duplex.destroyed) return;

    // Prevent `ws.terminate()` from being called by `duplex._destroy()`.
    //
    // - If the `'error'` event is emitted before the `'open'` event, then
    //   `ws.terminate()` is a noop as no socket is assigned.
    // - Otherwise, the error is re-emitted by the listener of the `'error'`
    //   event of the `Receiver` object. The listener already closes the
    //   connection by calling `ws.close()`. This allows a close frame to be
    //   sent to the other peer. If `ws.terminate()` is called right after this,
    //   then the close frame might not be sent.
    terminateOnDestroy = false;
    duplex.destroy(err);
  });

  ws.once('close', function close() {
    if (duplex.destroyed) return;

    duplex.push(null);
  });

  duplex._destroy = function (err, callback) {
    if (ws.readyState === ws.CLOSED) {
      callback(err);
      process.nextTick(emitClose, duplex);
      return;
    }

    let called = false;

    ws.once('error', function error(err) {
      called = true;
      callback(err);
    });

    ws.once('close', function close() {
      if (!called) callback(err);
      process.nextTick(emitClose, duplex);
    });

    if (terminateOnDestroy) ws.terminate();
  };

  duplex._final = function (callback) {
    if (ws.readyState === ws.CONNECTING) {
      ws.once('open', function open() {
        duplex._final(callback);
      });
      return;
    }

    // If the value of the `_socket` property is `null` it means that `ws` is a
    // client websocket and the handshake failed. In fact, when this happens, a
    // socket is never assigned to the websocket. Wait for the `'error'` event
    // that will be emitted by the websocket.
    if (ws._socket === null) return;

    if (ws._socket._writableState.finished) {
      callback();
      if (duplex._readableState.endEmitted) duplex.destroy();
    } else {
      ws._socket.once('finish', function finish() {
        // `duplex` is not destroyed here because the `'end'` event will be
        // emitted on `duplex` after this `'finish'` event. The EOF signaling
        // `null` chunk is, in fact, pushed when the websocket emits `'close'`.
        callback();
      });
      ws.close();
    }
  };

  duplex._read = function () {
    if (
      (ws.readyState === ws.OPEN || ws.readyState === ws.CLOSING) &&
      !resumeOnReceiverDrain
    ) {
      resumeOnReceiverDrain = true;
      if (!ws._receiver._writableState.needDrain) ws._socket.resume();
    }
  };

  duplex._write = function (chunk, encoding, callback) {
    if (ws.readyState === ws.CONNECTING) {
      ws.once('open', function open() {
        duplex._write(chunk, encoding, callback);
      });
      return;
    }

    ws.send(chunk, callback);
  };

  duplex.on('end', duplexOnEnd);
  duplex.on('error', duplexOnError);
  return duplex;
}

module.exports = createWebSocketStream;


/***/ }),

/***/ 76994:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const zlib = __webpack_require__(43106);

const bufferUtil = __webpack_require__(99405);
const Limiter = __webpack_require__(96596);
const { kStatusCode, NOOP } = __webpack_require__(43713);

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const kPerMessageDeflate = Symbol('permessage-deflate');
const kTotalLength = Symbol('total-length');
const kCallback = Symbol('callback');
const kBuffers = Symbol('buffers');
const kError = Symbol('error');

//
// We limit zlib concurrency, which prevents severe memory fragmentation
// as documented in https://github.com/nodejs/node/issues/8871#issuecomment-250915913
// and https://github.com/websockets/ws/issues/1202
//
// Intentionally global; it's the global thread pool that's an issue.
//
let zlibLimiter;

/**
 * permessage-deflate implementation.
 */
class PerMessageDeflate {
  /**
   * Creates a PerMessageDeflate instance.
   *
   * @param {Object} [options] Configuration options
   * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
   *     disabling of server context takeover
   * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
   *     acknowledge disabling of client context takeover
   * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
   *     use of a custom server window size
   * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
   *     for, or request, a custom client window size
   * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
   *     deflate
   * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
   *     inflate
   * @param {Number} [options.threshold=1024] Size (in bytes) below which
   *     messages should not be compressed
   * @param {Number} [options.concurrencyLimit=10] The number of concurrent
   *     calls to zlib
   * @param {Boolean} [isServer=false] Create the instance in either server or
   *     client mode
   * @param {Number} [maxPayload=0] The maximum allowed message length
   */
  constructor(options, isServer, maxPayload) {
    this._maxPayload = maxPayload | 0;
    this._options = options || {};
    this._threshold =
      this._options.threshold !== undefined ? this._options.threshold : 1024;
    this._isServer = !!isServer;
    this._deflate = null;
    this._inflate = null;

    this.params = null;

    if (!zlibLimiter) {
      const concurrency =
        this._options.concurrencyLimit !== undefined
          ? this._options.concurrencyLimit
          : 10;
      zlibLimiter = new Limiter(concurrency);
    }
  }

  /**
   * @type {String}
   */
  static get extensionName() {
    return 'permessage-deflate';
  }

  /**
   * Create an extension negotiation offer.
   *
   * @return {Object} Extension parameters
   * @public
   */
  offer() {
    const params = {};

    if (this._options.serverNoContextTakeover) {
      params.server_no_context_takeover = true;
    }
    if (this._options.clientNoContextTakeover) {
      params.client_no_context_takeover = true;
    }
    if (this._options.serverMaxWindowBits) {
      params.server_max_window_bits = this._options.serverMaxWindowBits;
    }
    if (this._options.clientMaxWindowBits) {
      params.client_max_window_bits = this._options.clientMaxWindowBits;
    } else if (this._options.clientMaxWindowBits == null) {
      params.client_max_window_bits = true;
    }

    return params;
  }

  /**
   * Accept an extension negotiation offer/response.
   *
   * @param {Array} configurations The extension negotiation offers/reponse
   * @return {Object} Accepted configuration
   * @public
   */
  accept(configurations) {
    configurations = this.normalizeParams(configurations);

    this.params = this._isServer
      ? this.acceptAsServer(configurations)
      : this.acceptAsClient(configurations);

    return this.params;
  }

  /**
   * Releases all resources used by the extension.
   *
   * @public
   */
  cleanup() {
    if (this._inflate) {
      this._inflate.close();
      this._inflate = null;
    }

    if (this._deflate) {
      const callback = this._deflate[kCallback];

      this._deflate.close();
      this._deflate = null;

      if (callback) {
        callback(
          new Error(
            'The deflate stream was closed while data was being processed'
          )
        );
      }
    }
  }

  /**
   *  Accept an extension negotiation offer.
   *
   * @param {Array} offers The extension negotiation offers
   * @return {Object} Accepted configuration
   * @private
   */
  acceptAsServer(offers) {
    const opts = this._options;
    const accepted = offers.find((params) => {
      if (
        (opts.serverNoContextTakeover === false &&
          params.server_no_context_takeover) ||
        (params.server_max_window_bits &&
          (opts.serverMaxWindowBits === false ||
            (typeof opts.serverMaxWindowBits === 'number' &&
              opts.serverMaxWindowBits > params.server_max_window_bits))) ||
        (typeof opts.clientMaxWindowBits === 'number' &&
          !params.client_max_window_bits)
      ) {
        return false;
      }

      return true;
    });

    if (!accepted) {
      throw new Error('None of the extension offers can be accepted');
    }

    if (opts.serverNoContextTakeover) {
      accepted.server_no_context_takeover = true;
    }
    if (opts.clientNoContextTakeover) {
      accepted.client_no_context_takeover = true;
    }
    if (typeof opts.serverMaxWindowBits === 'number') {
      accepted.server_max_window_bits = opts.serverMaxWindowBits;
    }
    if (typeof opts.clientMaxWindowBits === 'number') {
      accepted.client_max_window_bits = opts.clientMaxWindowBits;
    } else if (
      accepted.client_max_window_bits === true ||
      opts.clientMaxWindowBits === false
    ) {
      delete accepted.client_max_window_bits;
    }

    return accepted;
  }

  /**
   * Accept the extension negotiation response.
   *
   * @param {Array} response The extension negotiation response
   * @return {Object} Accepted configuration
   * @private
   */
  acceptAsClient(response) {
    const params = response[0];

    if (
      this._options.clientNoContextTakeover === false &&
      params.client_no_context_takeover
    ) {
      throw new Error('Unexpected parameter "client_no_context_takeover"');
    }

    if (!params.client_max_window_bits) {
      if (typeof this._options.clientMaxWindowBits === 'number') {
        params.client_max_window_bits = this._options.clientMaxWindowBits;
      }
    } else if (
      this._options.clientMaxWindowBits === false ||
      (typeof this._options.clientMaxWindowBits === 'number' &&
        params.client_max_window_bits > this._options.clientMaxWindowBits)
    ) {
      throw new Error(
        'Unexpected or invalid parameter "client_max_window_bits"'
      );
    }

    return params;
  }

  /**
   * Normalize parameters.
   *
   * @param {Array} configurations The extension negotiation offers/reponse
   * @return {Array} The offers/response with normalized parameters
   * @private
   */
  normalizeParams(configurations) {
    configurations.forEach((params) => {
      Object.keys(params).forEach((key) => {
        let value = params[key];

        if (value.length > 1) {
          throw new Error(`Parameter "${key}" must have only a single value`);
        }

        value = value[0];

        if (key === 'client_max_window_bits') {
          if (value !== true) {
            const num = +value;
            if (!Number.isInteger(num) || num < 8 || num > 15) {
              throw new TypeError(
                `Invalid value for parameter "${key}": ${value}`
              );
            }
            value = num;
          } else if (!this._isServer) {
            throw new TypeError(
              `Invalid value for parameter "${key}": ${value}`
            );
          }
        } else if (key === 'server_max_window_bits') {
          const num = +value;
          if (!Number.isInteger(num) || num < 8 || num > 15) {
            throw new TypeError(
              `Invalid value for parameter "${key}": ${value}`
            );
          }
          value = num;
        } else if (
          key === 'client_no_context_takeover' ||
          key === 'server_no_context_takeover'
        ) {
          if (value !== true) {
            throw new TypeError(
              `Invalid value for parameter "${key}": ${value}`
            );
          }
        } else {
          throw new Error(`Unknown parameter "${key}"`);
        }

        params[key] = value;
      });
    });

    return configurations;
  }

  /**
   * Decompress data. Concurrency limited.
   *
   * @param {Buffer} data Compressed data
   * @param {Boolean} fin Specifies whether or not this is the last fragment
   * @param {Function} callback Callback
   * @public
   */
  decompress(data, fin, callback) {
    zlibLimiter.add((done) => {
      this._decompress(data, fin, (err, result) => {
        done();
        callback(err, result);
      });
    });
  }

  /**
   * Compress data. Concurrency limited.
   *
   * @param {Buffer} data Data to compress
   * @param {Boolean} fin Specifies whether or not this is the last fragment
   * @param {Function} callback Callback
   * @public
   */
  compress(data, fin, callback) {
    zlibLimiter.add((done) => {
      this._compress(data, fin, (err, result) => {
        done();
        callback(err, result);
      });
    });
  }

  /**
   * Decompress data.
   *
   * @param {Buffer} data Compressed data
   * @param {Boolean} fin Specifies whether or not this is the last fragment
   * @param {Function} callback Callback
   * @private
   */
  _decompress(data, fin, callback) {
    const endpoint = this._isServer ? 'client' : 'server';

    if (!this._inflate) {
      const key = `${endpoint}_max_window_bits`;
      const windowBits =
        typeof this.params[key] !== 'number'
          ? zlib.Z_DEFAULT_WINDOWBITS
          : this.params[key];

      this._inflate = zlib.createInflateRaw({
        ...this._options.zlibInflateOptions,
        windowBits
      });
      this._inflate[kPerMessageDeflate] = this;
      this._inflate[kTotalLength] = 0;
      this._inflate[kBuffers] = [];
      this._inflate.on('error', inflateOnError);
      this._inflate.on('data', inflateOnData);
    }

    this._inflate[kCallback] = callback;

    this._inflate.write(data);
    if (fin) this._inflate.write(TRAILER);

    this._inflate.flush(() => {
      const err = this._inflate[kError];

      if (err) {
        this._inflate.close();
        this._inflate = null;
        callback(err);
        return;
      }

      const data = bufferUtil.concat(
        this._inflate[kBuffers],
        this._inflate[kTotalLength]
      );

      if (this._inflate._readableState.endEmitted) {
        this._inflate.close();
        this._inflate = null;
      } else {
        this._inflate[kTotalLength] = 0;
        this._inflate[kBuffers] = [];

        if (fin && this.params[`${endpoint}_no_context_takeover`]) {
          this._inflate.reset();
        }
      }

      callback(null, data);
    });
  }

  /**
   * Compress data.
   *
   * @param {Buffer} data Data to compress
   * @param {Boolean} fin Specifies whether or not this is the last fragment
   * @param {Function} callback Callback
   * @private
   */
  _compress(data, fin, callback) {
    const endpoint = this._isServer ? 'server' : 'client';

    if (!this._deflate) {
      const key = `${endpoint}_max_window_bits`;
      const windowBits =
        typeof this.params[key] !== 'number'
          ? zlib.Z_DEFAULT_WINDOWBITS
          : this.params[key];

      this._deflate = zlib.createDeflateRaw({
        ...this._options.zlibDeflateOptions,
        windowBits
      });

      this._deflate[kTotalLength] = 0;
      this._deflate[kBuffers] = [];

      //
      // An `'error'` event is emitted, only on Node.js < 10.0.0, if the
      // `zlib.DeflateRaw` instance is closed while data is being processed.
      // This can happen if `PerMessageDeflate#cleanup()` is called at the wrong
      // time due to an abnormal WebSocket closure.
      //
      this._deflate.on('error', NOOP);
      this._deflate.on('data', deflateOnData);
    }

    this._deflate[kCallback] = callback;

    this._deflate.write(data);
    this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
      if (!this._deflate) {
        //
        // The deflate stream was closed while data was being processed.
        //
        return;
      }

      let data = bufferUtil.concat(
        this._deflate[kBuffers],
        this._deflate[kTotalLength]
      );

      if (fin) data = data.slice(0, data.length - 4);

      //
      // Ensure that the callback will not be called again in
      // `PerMessageDeflate#cleanup()`.
      //
      this._deflate[kCallback] = null;

      this._deflate[kTotalLength] = 0;
      this._deflate[kBuffers] = [];

      if (fin && this.params[`${endpoint}_no_context_takeover`]) {
        this._deflate.reset();
      }

      callback(null, data);
    });
  }
}

module.exports = PerMessageDeflate;

/**
 * The listener of the `zlib.DeflateRaw` stream `'data'` event.
 *
 * @param {Buffer} chunk A chunk of data
 * @private
 */
function deflateOnData(chunk) {
  this[kBuffers].push(chunk);
  this[kTotalLength] += chunk.length;
}

/**
 * The listener of the `zlib.InflateRaw` stream `'data'` event.
 *
 * @param {Buffer} chunk A chunk of data
 * @private
 */
function inflateOnData(chunk) {
  this[kTotalLength] += chunk.length;

  if (
    this[kPerMessageDeflate]._maxPayload < 1 ||
    this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload
  ) {
    this[kBuffers].push(chunk);
    return;
  }

  this[kError] = new RangeError('Max payload size exceeded');
  this[kError].code = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
  this[kError][kStatusCode] = 1009;
  this.removeListener('data', inflateOnData);
  this.reset();
}

/**
 * The listener of the `zlib.InflateRaw` stream `'error'` event.
 *
 * @param {Error} err The emitted error
 * @private
 */
function inflateOnError(err) {
  //
  // There is no need to call `Zlib#close()` as the handle is automatically
  // closed when an error is emitted.
  //
  this[kPerMessageDeflate]._inflate = null;
  err[kStatusCode] = 1007;
  this[kCallback](err);
}


/***/ }),

/***/ 77173:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isBrowserCryptoAvailable = exports.getSubtleCrypto = exports.getBrowerCrypto = void 0;
function getBrowerCrypto() {
    return (global === null || global === void 0 ? void 0 : global.crypto) || (global === null || global === void 0 ? void 0 : global.msCrypto) || {};
}
exports.getBrowerCrypto = getBrowerCrypto;
function getSubtleCrypto() {
    const browserCrypto = getBrowerCrypto();
    return browserCrypto.subtle || browserCrypto.webkitSubtle;
}
exports.getSubtleCrypto = getSubtleCrypto;
function isBrowserCryptoAvailable() {
    return !!getBrowerCrypto() && !!getSubtleCrypto();
}
exports.isBrowserCryptoAvailable = isBrowserCryptoAvailable;
//# sourceMappingURL=crypto.js.map

/***/ }),

/***/ 78103:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const rx = __webpack_require__(41753)

module.exports = redactor

function redactor ({ secret, serialize, wcLen, strict, isCensorFct, censorFctTakesPath }, state) {
  /* eslint-disable-next-line */
  const redact = Function('o', `
    if (typeof o !== 'object' || o == null) {
      ${strictImpl(strict, serialize)}
    }
    const { censor, secret } = this
    const originalSecret = {}
    const secretKeys = Object.keys(secret)
    for (var i = 0; i < secretKeys.length; i++) {
      originalSecret[secretKeys[i]] = secret[secretKeys[i]]
    }

    ${redactTmpl(secret, isCensorFct, censorFctTakesPath)}
    this.compileRestore()
    ${dynamicRedactTmpl(wcLen > 0, isCensorFct, censorFctTakesPath)}
    this.secret = originalSecret
    ${resultTmpl(serialize)}
  `).bind(state)

  redact.state = state

  if (serialize === false) {
    redact.restore = (o) => state.restore(o)
  }

  return redact
}

function redactTmpl (secret, isCensorFct, censorFctTakesPath) {
  return Object.keys(secret).map((path) => {
    const { escPath, leadingBracket, path: arrPath } = secret[path]
    const skip = leadingBracket ? 1 : 0
    const delim = leadingBracket ? '' : '.'
    const hops = []
    var match
    while ((match = rx.exec(path)) !== null) {
      const [ , ix ] = match
      const { index, input } = match
      if (index > skip) hops.push(input.substring(0, index - (ix ? 0 : 1)))
    }
    var existence = hops.map((p) => `o${delim}${p}`).join(' && ')
    if (existence.length === 0) existence += `o${delim}${path} != null`
    else existence += ` && o${delim}${path} != null`

    const circularDetection = `
      switch (true) {
        ${hops.reverse().map((p) => `
          case o${delim}${p} === censor:
            secret[${escPath}].circle = ${JSON.stringify(p)}
            break
        `).join('\n')}
      }
    `

    const censorArgs = censorFctTakesPath
      ? `val, ${JSON.stringify(arrPath)}`
      : `val`

    return `
      if (${existence}) {
        const val = o${delim}${path}
        if (val === censor) {
          secret[${escPath}].precensored = true
        } else {
          secret[${escPath}].val = val
          o${delim}${path} = ${isCensorFct ? `censor(${censorArgs})` : 'censor'}
          ${circularDetection}
        }
      }
    `
  }).join('\n')
}

function dynamicRedactTmpl (hasWildcards, isCensorFct, censorFctTakesPath) {
  return hasWildcards === true ? `
    {
      const { wildcards, wcLen, groupRedact, nestedRedact } = this
      for (var i = 0; i < wcLen; i++) {
        const { before, beforeStr, after, nested } = wildcards[i]
        if (nested === true) {
          secret[beforeStr] = secret[beforeStr] || []
          nestedRedact(secret[beforeStr], o, before, after, censor, ${isCensorFct}, ${censorFctTakesPath})
        } else secret[beforeStr] = groupRedact(o, before, censor, ${isCensorFct}, ${censorFctTakesPath})
      }
    }
  ` : ''
}

function resultTmpl (serialize) {
  return serialize === false ? `return o` : `
    var s = this.serialize(o)
    this.restore(o)
    return s
  `
}

function strictImpl (strict, serialize) {
  return strict === true
    ? `throw Error('fast-redact: primitives cannot be redacted')`
    : serialize === false ? `return o` : `return this.serialize(o)`
}


/***/ }),

/***/ 79195:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { Writable } = __webpack_require__(2203);

const PerMessageDeflate = __webpack_require__(76994);
const {
  BINARY_TYPES,
  EMPTY_BUFFER,
  kStatusCode,
  kWebSocket
} = __webpack_require__(43713);
const { concat, toArrayBuffer, unmask } = __webpack_require__(99405);
const { isValidStatusCode, isValidUTF8 } = __webpack_require__(65177);

const GET_INFO = 0;
const GET_PAYLOAD_LENGTH_16 = 1;
const GET_PAYLOAD_LENGTH_64 = 2;
const GET_MASK = 3;
const GET_DATA = 4;
const INFLATING = 5;

/**
 * HyBi Receiver implementation.
 *
 * @extends Writable
 */
class Receiver extends Writable {
  /**
   * Creates a Receiver instance.
   *
   * @param {String} [binaryType=nodebuffer] The type for binary data
   * @param {Object} [extensions] An object containing the negotiated extensions
   * @param {Boolean} [isServer=false] Specifies whether to operate in client or
   *     server mode
   * @param {Number} [maxPayload=0] The maximum allowed message length
   */
  constructor(binaryType, extensions, isServer, maxPayload) {
    super();

    this._binaryType = binaryType || BINARY_TYPES[0];
    this[kWebSocket] = undefined;
    this._extensions = extensions || {};
    this._isServer = !!isServer;
    this._maxPayload = maxPayload | 0;

    this._bufferedBytes = 0;
    this._buffers = [];

    this._compressed = false;
    this._payloadLength = 0;
    this._mask = undefined;
    this._fragmented = 0;
    this._masked = false;
    this._fin = false;
    this._opcode = 0;

    this._totalPayloadLength = 0;
    this._messageLength = 0;
    this._fragments = [];

    this._state = GET_INFO;
    this._loop = false;
  }

  /**
   * Implements `Writable.prototype._write()`.
   *
   * @param {Buffer} chunk The chunk of data to write
   * @param {String} encoding The character encoding of `chunk`
   * @param {Function} cb Callback
   * @private
   */
  _write(chunk, encoding, cb) {
    if (this._opcode === 0x08 && this._state == GET_INFO) return cb();

    this._bufferedBytes += chunk.length;
    this._buffers.push(chunk);
    this.startLoop(cb);
  }

  /**
   * Consumes `n` bytes from the buffered data.
   *
   * @param {Number} n The number of bytes to consume
   * @return {Buffer} The consumed bytes
   * @private
   */
  consume(n) {
    this._bufferedBytes -= n;

    if (n === this._buffers[0].length) return this._buffers.shift();

    if (n < this._buffers[0].length) {
      const buf = this._buffers[0];
      this._buffers[0] = buf.slice(n);
      return buf.slice(0, n);
    }

    const dst = Buffer.allocUnsafe(n);

    do {
      const buf = this._buffers[0];
      const offset = dst.length - n;

      if (n >= buf.length) {
        dst.set(this._buffers.shift(), offset);
      } else {
        dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
        this._buffers[0] = buf.slice(n);
      }

      n -= buf.length;
    } while (n > 0);

    return dst;
  }

  /**
   * Starts the parsing loop.
   *
   * @param {Function} cb Callback
   * @private
   */
  startLoop(cb) {
    let err;
    this._loop = true;

    do {
      switch (this._state) {
        case GET_INFO:
          err = this.getInfo();
          break;
        case GET_PAYLOAD_LENGTH_16:
          err = this.getPayloadLength16();
          break;
        case GET_PAYLOAD_LENGTH_64:
          err = this.getPayloadLength64();
          break;
        case GET_MASK:
          this.getMask();
          break;
        case GET_DATA:
          err = this.getData(cb);
          break;
        default:
          // `INFLATING`
          this._loop = false;
          return;
      }
    } while (this._loop);

    cb(err);
  }

  /**
   * Reads the first two bytes of a frame.
   *
   * @return {(RangeError|undefined)} A possible error
   * @private
   */
  getInfo() {
    if (this._bufferedBytes < 2) {
      this._loop = false;
      return;
    }

    const buf = this.consume(2);

    if ((buf[0] & 0x30) !== 0x00) {
      this._loop = false;
      return error(
        RangeError,
        'RSV2 and RSV3 must be clear',
        true,
        1002,
        'WS_ERR_UNEXPECTED_RSV_2_3'
      );
    }

    const compressed = (buf[0] & 0x40) === 0x40;

    if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
      this._loop = false;
      return error(
        RangeError,
        'RSV1 must be clear',
        true,
        1002,
        'WS_ERR_UNEXPECTED_RSV_1'
      );
    }

    this._fin = (buf[0] & 0x80) === 0x80;
    this._opcode = buf[0] & 0x0f;
    this._payloadLength = buf[1] & 0x7f;

    if (this._opcode === 0x00) {
      if (compressed) {
        this._loop = false;
        return error(
          RangeError,
          'RSV1 must be clear',
          true,
          1002,
          'WS_ERR_UNEXPECTED_RSV_1'
        );
      }

      if (!this._fragmented) {
        this._loop = false;
        return error(
          RangeError,
          'invalid opcode 0',
          true,
          1002,
          'WS_ERR_INVALID_OPCODE'
        );
      }

      this._opcode = this._fragmented;
    } else if (this._opcode === 0x01 || this._opcode === 0x02) {
      if (this._fragmented) {
        this._loop = false;
        return error(
          RangeError,
          `invalid opcode ${this._opcode}`,
          true,
          1002,
          'WS_ERR_INVALID_OPCODE'
        );
      }

      this._compressed = compressed;
    } else if (this._opcode > 0x07 && this._opcode < 0x0b) {
      if (!this._fin) {
        this._loop = false;
        return error(
          RangeError,
          'FIN must be set',
          true,
          1002,
          'WS_ERR_EXPECTED_FIN'
        );
      }

      if (compressed) {
        this._loop = false;
        return error(
          RangeError,
          'RSV1 must be clear',
          true,
          1002,
          'WS_ERR_UNEXPECTED_RSV_1'
        );
      }

      if (this._payloadLength > 0x7d) {
        this._loop = false;
        return error(
          RangeError,
          `invalid payload length ${this._payloadLength}`,
          true,
          1002,
          'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH'
        );
      }
    } else {
      this._loop = false;
      return error(
        RangeError,
        `invalid opcode ${this._opcode}`,
        true,
        1002,
        'WS_ERR_INVALID_OPCODE'
      );
    }

    if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
    this._masked = (buf[1] & 0x80) === 0x80;

    if (this._isServer) {
      if (!this._masked) {
        this._loop = false;
        return error(
          RangeError,
          'MASK must be set',
          true,
          1002,
          'WS_ERR_EXPECTED_MASK'
        );
      }
    } else if (this._masked) {
      this._loop = false;
      return error(
        RangeError,
        'MASK must be clear',
        true,
        1002,
        'WS_ERR_UNEXPECTED_MASK'
      );
    }

    if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
    else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
    else return this.haveLength();
  }

  /**
   * Gets extended payload length (7+16).
   *
   * @return {(RangeError|undefined)} A possible error
   * @private
   */
  getPayloadLength16() {
    if (this._bufferedBytes < 2) {
      this._loop = false;
      return;
    }

    this._payloadLength = this.consume(2).readUInt16BE(0);
    return this.haveLength();
  }

  /**
   * Gets extended payload length (7+64).
   *
   * @return {(RangeError|undefined)} A possible error
   * @private
   */
  getPayloadLength64() {
    if (this._bufferedBytes < 8) {
      this._loop = false;
      return;
    }

    const buf = this.consume(8);
    const num = buf.readUInt32BE(0);

    //
    // The maximum safe integer in JavaScript is 2^53 - 1. An error is returned
    // if payload length is greater than this number.
    //
    if (num > Math.pow(2, 53 - 32) - 1) {
      this._loop = false;
      return error(
        RangeError,
        'Unsupported WebSocket frame: payload length > 2^53 - 1',
        false,
        1009,
        'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH'
      );
    }

    this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
    return this.haveLength();
  }

  /**
   * Payload length has been read.
   *
   * @return {(RangeError|undefined)} A possible error
   * @private
   */
  haveLength() {
    if (this._payloadLength && this._opcode < 0x08) {
      this._totalPayloadLength += this._payloadLength;
      if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
        this._loop = false;
        return error(
          RangeError,
          'Max payload size exceeded',
          false,
          1009,
          'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        );
      }
    }

    if (this._masked) this._state = GET_MASK;
    else this._state = GET_DATA;
  }

  /**
   * Reads mask bytes.
   *
   * @private
   */
  getMask() {
    if (this._bufferedBytes < 4) {
      this._loop = false;
      return;
    }

    this._mask = this.consume(4);
    this._state = GET_DATA;
  }

  /**
   * Reads data bytes.
   *
   * @param {Function} cb Callback
   * @return {(Error|RangeError|undefined)} A possible error
   * @private
   */
  getData(cb) {
    let data = EMPTY_BUFFER;

    if (this._payloadLength) {
      if (this._bufferedBytes < this._payloadLength) {
        this._loop = false;
        return;
      }

      data = this.consume(this._payloadLength);
      if (this._masked) unmask(data, this._mask);
    }

    if (this._opcode > 0x07) return this.controlMessage(data);

    if (this._compressed) {
      this._state = INFLATING;
      this.decompress(data, cb);
      return;
    }

    if (data.length) {
      //
      // This message is not compressed so its lenght is the sum of the payload
      // length of all fragments.
      //
      this._messageLength = this._totalPayloadLength;
      this._fragments.push(data);
    }

    return this.dataMessage();
  }

  /**
   * Decompresses data.
   *
   * @param {Buffer} data Compressed data
   * @param {Function} cb Callback
   * @private
   */
  decompress(data, cb) {
    const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];

    perMessageDeflate.decompress(data, this._fin, (err, buf) => {
      if (err) return cb(err);

      if (buf.length) {
        this._messageLength += buf.length;
        if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
          return cb(
            error(
              RangeError,
              'Max payload size exceeded',
              false,
              1009,
              'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
            )
          );
        }

        this._fragments.push(buf);
      }

      const er = this.dataMessage();
      if (er) return cb(er);

      this.startLoop(cb);
    });
  }

  /**
   * Handles a data message.
   *
   * @return {(Error|undefined)} A possible error
   * @private
   */
  dataMessage() {
    if (this._fin) {
      const messageLength = this._messageLength;
      const fragments = this._fragments;

      this._totalPayloadLength = 0;
      this._messageLength = 0;
      this._fragmented = 0;
      this._fragments = [];

      if (this._opcode === 2) {
        let data;

        if (this._binaryType === 'nodebuffer') {
          data = concat(fragments, messageLength);
        } else if (this._binaryType === 'arraybuffer') {
          data = toArrayBuffer(concat(fragments, messageLength));
        } else {
          data = fragments;
        }

        this.emit('message', data);
      } else {
        const buf = concat(fragments, messageLength);

        if (!isValidUTF8(buf)) {
          this._loop = false;
          return error(
            Error,
            'invalid UTF-8 sequence',
            true,
            1007,
            'WS_ERR_INVALID_UTF8'
          );
        }

        this.emit('message', buf.toString());
      }
    }

    this._state = GET_INFO;
  }

  /**
   * Handles a control message.
   *
   * @param {Buffer} data Data to handle
   * @return {(Error|RangeError|undefined)} A possible error
   * @private
   */
  controlMessage(data) {
    if (this._opcode === 0x08) {
      this._loop = false;

      if (data.length === 0) {
        this.emit('conclude', 1005, '');
        this.end();
      } else if (data.length === 1) {
        return error(
          RangeError,
          'invalid payload length 1',
          true,
          1002,
          'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH'
        );
      } else {
        const code = data.readUInt16BE(0);

        if (!isValidStatusCode(code)) {
          return error(
            RangeError,
            `invalid status code ${code}`,
            true,
            1002,
            'WS_ERR_INVALID_CLOSE_CODE'
          );
        }

        const buf = data.slice(2);

        if (!isValidUTF8(buf)) {
          return error(
            Error,
            'invalid UTF-8 sequence',
            true,
            1007,
            'WS_ERR_INVALID_UTF8'
          );
        }

        this.emit('conclude', code, buf.toString());
        this.end();
      }
    } else if (this._opcode === 0x09) {
      this.emit('ping', data);
    } else {
      this.emit('pong', data);
    }

    this._state = GET_INFO;
  }
}

module.exports = Receiver;

/**
 * Builds an error object.
 *
 * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
 * @param {String} message The error message
 * @param {Boolean} prefix Specifies whether or not to add a default prefix to
 *     `message`
 * @param {Number} statusCode The status code
 * @param {String} errorCode The exposed error code
 * @return {(Error|RangeError)} The error
 * @private
 */
function error(ErrorCtor, message, prefix, statusCode, errorCode) {
  const err = new ErrorCtor(
    prefix ? `Invalid WebSocket frame: ${message}` : message
  );

  Error.captureStackTrace(err, error);
  err.code = errorCode;
  err[kStatusCode] = statusCode;
  return err;
}


/***/ }),

/***/ 79244:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ONE_THOUSAND = exports.ONE_HUNDRED = void 0;
exports.ONE_HUNDRED = 100;
exports.ONE_THOUSAND = 1000;
//# sourceMappingURL=misc.js.map

/***/ }),

/***/ 80584:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   __assign: () => (/* binding */ __assign),
/* harmony export */   __asyncDelegator: () => (/* binding */ __asyncDelegator),
/* harmony export */   __asyncGenerator: () => (/* binding */ __asyncGenerator),
/* harmony export */   __asyncValues: () => (/* binding */ __asyncValues),
/* harmony export */   __await: () => (/* binding */ __await),
/* harmony export */   __awaiter: () => (/* binding */ __awaiter),
/* harmony export */   __classPrivateFieldGet: () => (/* binding */ __classPrivateFieldGet),
/* harmony export */   __classPrivateFieldSet: () => (/* binding */ __classPrivateFieldSet),
/* harmony export */   __createBinding: () => (/* binding */ __createBinding),
/* harmony export */   __decorate: () => (/* binding */ __decorate),
/* harmony export */   __exportStar: () => (/* binding */ __exportStar),
/* harmony export */   __extends: () => (/* binding */ __extends),
/* harmony export */   __generator: () => (/* binding */ __generator),
/* harmony export */   __importDefault: () => (/* binding */ __importDefault),
/* harmony export */   __importStar: () => (/* binding */ __importStar),
/* harmony export */   __makeTemplateObject: () => (/* binding */ __makeTemplateObject),
/* harmony export */   __metadata: () => (/* binding */ __metadata),
/* harmony export */   __param: () => (/* binding */ __param),
/* harmony export */   __read: () => (/* binding */ __read),
/* harmony export */   __rest: () => (/* binding */ __rest),
/* harmony export */   __spread: () => (/* binding */ __spread),
/* harmony export */   __spreadArrays: () => (/* binding */ __spreadArrays),
/* harmony export */   __values: () => (/* binding */ __values)
/* harmony export */ });
/*! *****************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise */

var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return extendStatics(d, b);
};

function __extends(d, b) {
    extendStatics(d, b);
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

var __assign = function() {
    __assign = Object.assign || function __assign(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
    }
    return __assign.apply(this, arguments);
}

function __rest(s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
}

function __decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}

function __param(paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
}

function __metadata(metadataKey, metadataValue) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}

function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

function __generator(thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
}

function __createBinding(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}

function __exportStar(m, exports) {
    for (var p in m) if (p !== "default" && !exports.hasOwnProperty(p)) exports[p] = m[p];
}

function __values(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

function __read(o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
}

function __spread() {
    for (var ar = [], i = 0; i < arguments.length; i++)
        ar = ar.concat(__read(arguments[i]));
    return ar;
}

function __spreadArrays() {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};

function __await(v) {
    return this instanceof __await ? (this.v = v, this) : new __await(v);
}

function __asyncGenerator(thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
    function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
}

function __asyncDelegator(o) {
    var i, p;
    return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
    function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: n === "return" } : f ? f(v) : v; } : f; }
}

function __asyncValues(o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
}

function __makeTemplateObject(cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
};

function __importStar(mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result.default = mod;
    return result;
}

function __importDefault(mod) {
    return (mod && mod.__esModule) ? mod : { default: mod };
}

function __classPrivateFieldGet(receiver, privateMap) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to get private field on non-instance");
    }
    return privateMap.get(receiver);
}

function __classPrivateFieldSet(receiver, privateMap, value) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to set private field on non-instance");
    }
    privateMap.set(receiver, value);
    return value;
}


/***/ }),

/***/ 81423:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const validator = __webpack_require__(33925)
const parse = __webpack_require__(3288)
const redactor = __webpack_require__(78103)
const restorer = __webpack_require__(2187)
const { groupRedact, nestedRedact } = __webpack_require__(97157)
const state = __webpack_require__(86754)
const rx = __webpack_require__(41753)
const validate = validator()
const noop = (o) => o
noop.restore = noop

const DEFAULT_CENSOR = '[REDACTED]'
fastRedact.rx = rx
fastRedact.validator = validator

module.exports = fastRedact

function fastRedact (opts = {}) {
  const paths = Array.from(new Set(opts.paths || []))
  const serialize = 'serialize' in opts ? (
    opts.serialize === false ? opts.serialize
      : (typeof opts.serialize === 'function' ? opts.serialize : JSON.stringify)
  ) : JSON.stringify
  const remove = opts.remove
  if (remove === true && serialize !== JSON.stringify) {
    throw Error('fast-redact – remove option may only be set when serializer is JSON.stringify')
  }
  const censor = remove === true
    ? undefined
    : 'censor' in opts ? opts.censor : DEFAULT_CENSOR

  const isCensorFct = typeof censor === 'function'
  const censorFctTakesPath = isCensorFct && censor.length > 1

  if (paths.length === 0) return serialize || noop

  validate({ paths, serialize, censor })

  const { wildcards, wcLen, secret } = parse({ paths, censor })

  const compileRestore = restorer()
  const strict = 'strict' in opts ? opts.strict : true

  return redactor({ secret, wcLen, serialize, strict, isCensorFct, censorFctTakesPath }, state({
    secret,
    censor,
    compileRestore,
    serialize,
    groupRedact,
    nestedRedact,
    wildcards,
    wcLen
  }))
}


/***/ }),

/***/ 82055:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "^net|tls$" }] */



const net = __webpack_require__(69278);
const tls = __webpack_require__(64756);
const { randomFillSync } = __webpack_require__(76982);

const PerMessageDeflate = __webpack_require__(76994);
const { EMPTY_BUFFER } = __webpack_require__(43713);
const { isValidStatusCode } = __webpack_require__(65177);
const { mask: applyMask, toBuffer } = __webpack_require__(99405);

const mask = Buffer.alloc(4);

/**
 * HyBi Sender implementation.
 */
class Sender {
  /**
   * Creates a Sender instance.
   *
   * @param {(net.Socket|tls.Socket)} socket The connection socket
   * @param {Object} [extensions] An object containing the negotiated extensions
   */
  constructor(socket, extensions) {
    this._extensions = extensions || {};
    this._socket = socket;

    this._firstFragment = true;
    this._compress = false;

    this._bufferedBytes = 0;
    this._deflating = false;
    this._queue = [];
  }

  /**
   * Frames a piece of data according to the HyBi WebSocket protocol.
   *
   * @param {Buffer} data The data to frame
   * @param {Object} options Options object
   * @param {Number} options.opcode The opcode
   * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
   *     modified
   * @param {Boolean} [options.fin=false] Specifies whether or not to set the
   *     FIN bit
   * @param {Boolean} [options.mask=false] Specifies whether or not to mask
   *     `data`
   * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
   *     RSV1 bit
   * @return {Buffer[]} The framed data as a list of `Buffer` instances
   * @public
   */
  static frame(data, options) {
    const merge = options.mask && options.readOnly;
    let offset = options.mask ? 6 : 2;
    let payloadLength = data.length;

    if (data.length >= 65536) {
      offset += 8;
      payloadLength = 127;
    } else if (data.length > 125) {
      offset += 2;
      payloadLength = 126;
    }

    const target = Buffer.allocUnsafe(merge ? data.length + offset : offset);

    target[0] = options.fin ? options.opcode | 0x80 : options.opcode;
    if (options.rsv1) target[0] |= 0x40;

    target[1] = payloadLength;

    if (payloadLength === 126) {
      target.writeUInt16BE(data.length, 2);
    } else if (payloadLength === 127) {
      target.writeUInt32BE(0, 2);
      target.writeUInt32BE(data.length, 6);
    }

    if (!options.mask) return [target, data];

    randomFillSync(mask, 0, 4);

    target[1] |= 0x80;
    target[offset - 4] = mask[0];
    target[offset - 3] = mask[1];
    target[offset - 2] = mask[2];
    target[offset - 1] = mask[3];

    if (merge) {
      applyMask(data, mask, target, offset, data.length);
      return [target];
    }

    applyMask(data, mask, data, 0, data.length);
    return [target, data];
  }

  /**
   * Sends a close message to the other peer.
   *
   * @param {Number} [code] The status code component of the body
   * @param {String} [data] The message component of the body
   * @param {Boolean} [mask=false] Specifies whether or not to mask the message
   * @param {Function} [cb] Callback
   * @public
   */
  close(code, data, mask, cb) {
    let buf;

    if (code === undefined) {
      buf = EMPTY_BUFFER;
    } else if (typeof code !== 'number' || !isValidStatusCode(code)) {
      throw new TypeError('First argument must be a valid error code number');
    } else if (data === undefined || data === '') {
      buf = Buffer.allocUnsafe(2);
      buf.writeUInt16BE(code, 0);
    } else {
      const length = Buffer.byteLength(data);

      if (length > 123) {
        throw new RangeError('The message must not be greater than 123 bytes');
      }

      buf = Buffer.allocUnsafe(2 + length);
      buf.writeUInt16BE(code, 0);
      buf.write(data, 2);
    }

    if (this._deflating) {
      this.enqueue([this.doClose, buf, mask, cb]);
    } else {
      this.doClose(buf, mask, cb);
    }
  }

  /**
   * Frames and sends a close message.
   *
   * @param {Buffer} data The message to send
   * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
   * @param {Function} [cb] Callback
   * @private
   */
  doClose(data, mask, cb) {
    this.sendFrame(
      Sender.frame(data, {
        fin: true,
        rsv1: false,
        opcode: 0x08,
        mask,
        readOnly: false
      }),
      cb
    );
  }

  /**
   * Sends a ping message to the other peer.
   *
   * @param {*} data The message to send
   * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
   * @param {Function} [cb] Callback
   * @public
   */
  ping(data, mask, cb) {
    const buf = toBuffer(data);

    if (buf.length > 125) {
      throw new RangeError('The data size must not be greater than 125 bytes');
    }

    if (this._deflating) {
      this.enqueue([this.doPing, buf, mask, toBuffer.readOnly, cb]);
    } else {
      this.doPing(buf, mask, toBuffer.readOnly, cb);
    }
  }

  /**
   * Frames and sends a ping message.
   *
   * @param {Buffer} data The message to send
   * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
   * @param {Boolean} [readOnly=false] Specifies whether `data` can be modified
   * @param {Function} [cb] Callback
   * @private
   */
  doPing(data, mask, readOnly, cb) {
    this.sendFrame(
      Sender.frame(data, {
        fin: true,
        rsv1: false,
        opcode: 0x09,
        mask,
        readOnly
      }),
      cb
    );
  }

  /**
   * Sends a pong message to the other peer.
   *
   * @param {*} data The message to send
   * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
   * @param {Function} [cb] Callback
   * @public
   */
  pong(data, mask, cb) {
    const buf = toBuffer(data);

    if (buf.length > 125) {
      throw new RangeError('The data size must not be greater than 125 bytes');
    }

    if (this._deflating) {
      this.enqueue([this.doPong, buf, mask, toBuffer.readOnly, cb]);
    } else {
      this.doPong(buf, mask, toBuffer.readOnly, cb);
    }
  }

  /**
   * Frames and sends a pong message.
   *
   * @param {Buffer} data The message to send
   * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
   * @param {Boolean} [readOnly=false] Specifies whether `data` can be modified
   * @param {Function} [cb] Callback
   * @private
   */
  doPong(data, mask, readOnly, cb) {
    this.sendFrame(
      Sender.frame(data, {
        fin: true,
        rsv1: false,
        opcode: 0x0a,
        mask,
        readOnly
      }),
      cb
    );
  }

  /**
   * Sends a data message to the other peer.
   *
   * @param {*} data The message to send
   * @param {Object} options Options object
   * @param {Boolean} [options.compress=false] Specifies whether or not to
   *     compress `data`
   * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
   *     or text
   * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
   *     last one
   * @param {Boolean} [options.mask=false] Specifies whether or not to mask
   *     `data`
   * @param {Function} [cb] Callback
   * @public
   */
  send(data, options, cb) {
    const buf = toBuffer(data);
    const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
    let opcode = options.binary ? 2 : 1;
    let rsv1 = options.compress;

    if (this._firstFragment) {
      this._firstFragment = false;
      if (rsv1 && perMessageDeflate) {
        rsv1 = buf.length >= perMessageDeflate._threshold;
      }
      this._compress = rsv1;
    } else {
      rsv1 = false;
      opcode = 0;
    }

    if (options.fin) this._firstFragment = true;

    if (perMessageDeflate) {
      const opts = {
        fin: options.fin,
        rsv1,
        opcode,
        mask: options.mask,
        readOnly: toBuffer.readOnly
      };

      if (this._deflating) {
        this.enqueue([this.dispatch, buf, this._compress, opts, cb]);
      } else {
        this.dispatch(buf, this._compress, opts, cb);
      }
    } else {
      this.sendFrame(
        Sender.frame(buf, {
          fin: options.fin,
          rsv1: false,
          opcode,
          mask: options.mask,
          readOnly: toBuffer.readOnly
        }),
        cb
      );
    }
  }

  /**
   * Dispatches a data message.
   *
   * @param {Buffer} data The message to send
   * @param {Boolean} [compress=false] Specifies whether or not to compress
   *     `data`
   * @param {Object} options Options object
   * @param {Number} options.opcode The opcode
   * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
   *     modified
   * @param {Boolean} [options.fin=false] Specifies whether or not to set the
   *     FIN bit
   * @param {Boolean} [options.mask=false] Specifies whether or not to mask
   *     `data`
   * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
   *     RSV1 bit
   * @param {Function} [cb] Callback
   * @private
   */
  dispatch(data, compress, options, cb) {
    if (!compress) {
      this.sendFrame(Sender.frame(data, options), cb);
      return;
    }

    const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];

    this._bufferedBytes += data.length;
    this._deflating = true;
    perMessageDeflate.compress(data, options.fin, (_, buf) => {
      if (this._socket.destroyed) {
        const err = new Error(
          'The socket was closed while data was being compressed'
        );

        if (typeof cb === 'function') cb(err);

        for (let i = 0; i < this._queue.length; i++) {
          const callback = this._queue[i][4];

          if (typeof callback === 'function') callback(err);
        }

        return;
      }

      this._bufferedBytes -= data.length;
      this._deflating = false;
      options.readOnly = false;
      this.sendFrame(Sender.frame(buf, options), cb);
      this.dequeue();
    });
  }

  /**
   * Executes queued send operations.
   *
   * @private
   */
  dequeue() {
    while (!this._deflating && this._queue.length) {
      const params = this._queue.shift();

      this._bufferedBytes -= params[1].length;
      Reflect.apply(params[0], this, params.slice(1));
    }
  }

  /**
   * Enqueues a send operation.
   *
   * @param {Array} params Send operation parameters.
   * @private
   */
  enqueue(params) {
    this._bufferedBytes += params[1].length;
    this._queue.push(params);
  }

  /**
   * Sends a frame.
   *
   * @param {Buffer[]} list The frame to send
   * @param {Function} [cb] Callback
   * @private
   */
  sendFrame(list, cb) {
    if (list.length === 2) {
      this._socket.cork();
      this._socket.write(list[0]);
      this._socket.write(list[1], cb);
      this._socket.uncork();
    } else {
      this._socket.write(list[0], cb);
    }
  }
}

module.exports = Sender;


/***/ }),

/***/ 82563:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { createRequire } = __webpack_require__(73339)
const getCallers = __webpack_require__(54811)
const { join, isAbsolute } = __webpack_require__(16928)
const sleep = __webpack_require__(57814)

let onExit

if (global.WeakRef && global.WeakMap && global.FinalizationRegistry) {
  // This require MUST be top level otherwise the transport would
  // not work from within Jest as it hijacks require.
  onExit = __webpack_require__(46270)
}

const ThreadStream = __webpack_require__(59348)

function setupOnExit (stream) {
  /* istanbul ignore next */
  if (onExit) {
    // This is leak free, it does not leave event handlers
    onExit.register(stream, autoEnd)

    stream.on('close', function () {
      onExit.unregister(stream)
    })
  } else {
    const fn = autoEnd.bind(null, stream)
    process.once('beforeExit', fn)
    process.once('exit', fn)

    stream.on('close', function () {
      process.removeListener('beforeExit', fn)
      process.removeListener('exit', fn)
    })
  }
}

function buildStream (filename, workerData, workerOpts) {
  const stream = new ThreadStream({
    filename,
    workerData,
    workerOpts
  })

  stream.on('ready', onReady)
  stream.on('close', function () {
    process.removeListener('exit', onExit)
  })

  process.on('exit', onExit)

  function onReady () {
    process.removeListener('exit', onExit)
    stream.unref()

    if (workerOpts.autoEnd !== false) {
      setupOnExit(stream)
    }
  }

  function onExit () {
    if (stream.closed) {
      return
    }
    stream.flushSync()
    // Apparently there is a very sporadic race condition
    // that in certain OS would prevent the messages to be flushed
    // because the thread might not have been created still.
    // Unfortunately we need to sleep(100) in this case.
    sleep(100)
    stream.end()
  }

  return stream
}

function autoEnd (stream) {
  stream.ref()
  stream.flushSync()
  stream.end()
  stream.once('close', function () {
    stream.unref()
  })
}

function transport (fullOptions) {
  const { pipeline, targets, levels, options = {}, worker = {}, caller = getCallers() } = fullOptions

  // Backwards compatibility
  const callers = typeof caller === 'string' ? [caller] : caller

  // This will be eventually modified by bundlers
  const bundlerOverrides = '__bundlerPathsOverrides' in globalThis ? globalThis.__bundlerPathsOverrides : {}

  let target = fullOptions.target

  if (target && targets) {
    throw new Error('only one of target or targets can be specified')
  }

  if (targets) {
    target = bundlerOverrides['pino-worker'] || join(__dirname, 'worker.js')
    options.targets = targets.map((dest) => {
      return {
        ...dest,
        target: fixTarget(dest.target)
      }
    })
  } else if (pipeline) {
    target = bundlerOverrides['pino-pipeline-worker'] || join(__dirname, 'worker-pipeline.js')
    options.targets = pipeline.map((dest) => {
      return {
        ...dest,
        target: fixTarget(dest.target)
      }
    })
  }

  if (levels) {
    options.levels = levels
  }

  return buildStream(fixTarget(target), options, worker)

  function fixTarget (origin) {
    origin = bundlerOverrides[origin] || origin

    if (isAbsolute(origin) || origin.indexOf('file://') === 0) {
      return origin
    }

    if (origin === 'pino/file') {
      return join(__dirname, '..', 'file.js')
    }

    let fixTarget

    for (const filePath of callers) {
      try {
        fixTarget = createRequire(filePath).resolve(origin)
        break
      } catch (err) {
        // Silent catch
        continue
      }
    }

    if (!fixTarget) {
      throw new Error(`unable to determine transport target for "${origin}"`)
    }

    return fixTarget
  }
}

module.exports = transport


/***/ }),

/***/ 84344:
/***/ ((module) => {



module.exports = {
  mapHttpResponse,
  resSerializer
}

const rawSymbol = Symbol('pino-raw-res-ref')
const pinoResProto = Object.create({}, {
  statusCode: {
    enumerable: true,
    writable: true,
    value: 0
  },
  headers: {
    enumerable: true,
    writable: true,
    value: ''
  },
  raw: {
    enumerable: false,
    get: function () {
      return this[rawSymbol]
    },
    set: function (val) {
      this[rawSymbol] = val
    }
  }
})
Object.defineProperty(pinoResProto, rawSymbol, {
  writable: true,
  value: {}
})

function resSerializer (res) {
  const _res = Object.create(pinoResProto)
  _res.statusCode = res.statusCode
  _res.headers = res.getHeaders ? res.getHeaders() : res._headers
  _res.raw = res
  return _res
}

function mapHttpResponse (res) {
  return {
    res: resSerializer(res)
  }
}


/***/ }),

/***/ 84984:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  REQUIRED_METHODS: () => (/* binding */ ethereum_provider_dist_index_es_u),
  "default": () => (/* binding */ ethereum_provider_dist_index_es_w)
});

// UNUSED EXPORTS: EthereumProvider, OPTIONAL_EVENTS, OPTIONAL_METHODS, REQUIRED_EVENTS

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/identity.js
var identity_namespaceObject = {};
__webpack_require__.r(identity_namespaceObject);
__webpack_require__.d(identity_namespaceObject, {
  identity: () => (identity)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base2.js
var base2_namespaceObject = {};
__webpack_require__.r(base2_namespaceObject);
__webpack_require__.d(base2_namespaceObject, {
  base2: () => (base2)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base8.js
var base8_namespaceObject = {};
__webpack_require__.r(base8_namespaceObject);
__webpack_require__.d(base8_namespaceObject, {
  base8: () => (base8)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base10.js
var base10_namespaceObject = {};
__webpack_require__.r(base10_namespaceObject);
__webpack_require__.d(base10_namespaceObject, {
  base10: () => (base10)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base16.js
var base16_namespaceObject = {};
__webpack_require__.r(base16_namespaceObject);
__webpack_require__.d(base16_namespaceObject, {
  base16: () => (base16),
  base16upper: () => (base16upper)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base36.js
var base36_namespaceObject = {};
__webpack_require__.r(base36_namespaceObject);
__webpack_require__.d(base36_namespaceObject, {
  base36: () => (base36),
  base36upper: () => (base36upper)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base64.js
var base64_namespaceObject = {};
__webpack_require__.r(base64_namespaceObject);
__webpack_require__.d(base64_namespaceObject, {
  base64: () => (base64),
  base64pad: () => (base64pad),
  base64url: () => (base64url),
  base64urlpad: () => (base64urlpad)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/bases/base256emoji.js
var base256emoji_namespaceObject = {};
__webpack_require__.r(base256emoji_namespaceObject);
__webpack_require__.d(base256emoji_namespaceObject, {
  base256emoji: () => (base256emoji)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/hashes/sha2.js
var sha2_namespaceObject = {};
__webpack_require__.r(sha2_namespaceObject);
__webpack_require__.d(sha2_namespaceObject, {
  sha256: () => (sha256),
  sha512: () => (sha512)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/hashes/identity.js
var hashes_identity_namespaceObject = {};
__webpack_require__.r(hashes_identity_namespaceObject);
__webpack_require__.d(hashes_identity_namespaceObject, {
  identity: () => (identity_identity)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/codecs/raw.js
var raw_namespaceObject = {};
__webpack_require__.r(raw_namespaceObject);
__webpack_require__.d(raw_namespaceObject, {
  code: () => (raw_code),
  decode: () => (raw_decode),
  encode: () => (raw_encode),
  name: () => (raw_name)
});

// NAMESPACE OBJECT: ./node_modules/multiformats/esm/src/codecs/json.js
var json_namespaceObject = {};
__webpack_require__.r(json_namespaceObject);
__webpack_require__.d(json_namespaceObject, {
  code: () => (json_code),
  decode: () => (json_decode),
  encode: () => (json_encode),
  name: () => (json_name)
});

// EXTERNAL MODULE: external "events"
var external_events_ = __webpack_require__(24434);
var external_events_default = /*#__PURE__*/__webpack_require__.n(external_events_);
;// ./node_modules/detect-browser/es/index.js
var __spreadArray = (undefined && undefined.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var BrowserInfo = /** @class */ (function () {
    function BrowserInfo(name, version, os) {
        this.name = name;
        this.version = version;
        this.os = os;
        this.type = 'browser';
    }
    return BrowserInfo;
}());

var NodeInfo = /** @class */ (function () {
    function NodeInfo(version) {
        this.version = version;
        this.type = 'node';
        this.name = 'node';
        this.os = process.platform;
    }
    return NodeInfo;
}());

var SearchBotDeviceInfo = /** @class */ (function () {
    function SearchBotDeviceInfo(name, version, os, bot) {
        this.name = name;
        this.version = version;
        this.os = os;
        this.bot = bot;
        this.type = 'bot-device';
    }
    return SearchBotDeviceInfo;
}());

var BotInfo = /** @class */ (function () {
    function BotInfo() {
        this.type = 'bot';
        this.bot = true; // NOTE: deprecated test name instead
        this.name = 'bot';
        this.version = null;
        this.os = null;
    }
    return BotInfo;
}());

var ReactNativeInfo = /** @class */ (function () {
    function ReactNativeInfo() {
        this.type = 'react-native';
        this.name = 'react-native';
        this.version = null;
        this.os = null;
    }
    return ReactNativeInfo;
}());

// tslint:disable-next-line:max-line-length
var SEARCHBOX_UA_REGEX = /alexa|bot|crawl(er|ing)|facebookexternalhit|feedburner|google web preview|nagios|postrank|pingdom|slurp|spider|yahoo!|yandex/;
var SEARCHBOT_OS_REGEX = /(nuhk|curl|Googlebot|Yammybot|Openbot|Slurp|MSNBot|Ask\ Jeeves\/Teoma|ia_archiver)/;
var REQUIRED_VERSION_PARTS = 3;
var userAgentRules = [
    ['aol', /AOLShield\/([0-9\._]+)/],
    ['edge', /Edge\/([0-9\._]+)/],
    ['edge-ios', /EdgiOS\/([0-9\._]+)/],
    ['yandexbrowser', /YaBrowser\/([0-9\._]+)/],
    ['kakaotalk', /KAKAOTALK\s([0-9\.]+)/],
    ['samsung', /SamsungBrowser\/([0-9\.]+)/],
    ['silk', /\bSilk\/([0-9._-]+)\b/],
    ['miui', /MiuiBrowser\/([0-9\.]+)$/],
    ['beaker', /BeakerBrowser\/([0-9\.]+)/],
    ['edge-chromium', /EdgA?\/([0-9\.]+)/],
    [
        'chromium-webview',
        /(?!Chrom.*OPR)wv\).*Chrom(?:e|ium)\/([0-9\.]+)(:?\s|$)/,
    ],
    ['chrome', /(?!Chrom.*OPR)Chrom(?:e|ium)\/([0-9\.]+)(:?\s|$)/],
    ['phantomjs', /PhantomJS\/([0-9\.]+)(:?\s|$)/],
    ['crios', /CriOS\/([0-9\.]+)(:?\s|$)/],
    ['firefox', /Firefox\/([0-9\.]+)(?:\s|$)/],
    ['fxios', /FxiOS\/([0-9\.]+)/],
    ['opera-mini', /Opera Mini.*Version\/([0-9\.]+)/],
    ['opera', /Opera\/([0-9\.]+)(?:\s|$)/],
    ['opera', /OPR\/([0-9\.]+)(:?\s|$)/],
    ['pie', /^Microsoft Pocket Internet Explorer\/(\d+\.\d+)$/],
    ['pie', /^Mozilla\/\d\.\d+\s\(compatible;\s(?:MSP?IE|MSInternet Explorer) (\d+\.\d+);.*Windows CE.*\)$/],
    ['netfront', /^Mozilla\/\d\.\d+.*NetFront\/(\d.\d)/],
    ['ie', /Trident\/7\.0.*rv\:([0-9\.]+).*\).*Gecko$/],
    ['ie', /MSIE\s([0-9\.]+);.*Trident\/[4-7].0/],
    ['ie', /MSIE\s(7\.0)/],
    ['bb10', /BB10;\sTouch.*Version\/([0-9\.]+)/],
    ['android', /Android\s([0-9\.]+)/],
    ['ios', /Version\/([0-9\._]+).*Mobile.*Safari.*/],
    ['safari', /Version\/([0-9\._]+).*Safari/],
    ['facebook', /FB[AS]V\/([0-9\.]+)/],
    ['instagram', /Instagram\s([0-9\.]+)/],
    ['ios-webview', /AppleWebKit\/([0-9\.]+).*Mobile/],
    ['ios-webview', /AppleWebKit\/([0-9\.]+).*Gecko\)$/],
    ['curl', /^curl\/([0-9\.]+)$/],
    ['searchbot', SEARCHBOX_UA_REGEX],
];
var operatingSystemRules = [
    ['iOS', /iP(hone|od|ad)/],
    ['Android OS', /Android/],
    ['BlackBerry OS', /BlackBerry|BB10/],
    ['Windows Mobile', /IEMobile/],
    ['Amazon OS', /Kindle/],
    ['Windows 3.11', /Win16/],
    ['Windows 95', /(Windows 95)|(Win95)|(Windows_95)/],
    ['Windows 98', /(Windows 98)|(Win98)/],
    ['Windows 2000', /(Windows NT 5.0)|(Windows 2000)/],
    ['Windows XP', /(Windows NT 5.1)|(Windows XP)/],
    ['Windows Server 2003', /(Windows NT 5.2)/],
    ['Windows Vista', /(Windows NT 6.0)/],
    ['Windows 7', /(Windows NT 6.1)/],
    ['Windows 8', /(Windows NT 6.2)/],
    ['Windows 8.1', /(Windows NT 6.3)/],
    ['Windows 10', /(Windows NT 10.0)/],
    ['Windows ME', /Windows ME/],
    ['Windows CE', /Windows CE|WinCE|Microsoft Pocket Internet Explorer/],
    ['Open BSD', /OpenBSD/],
    ['Sun OS', /SunOS/],
    ['Chrome OS', /CrOS/],
    ['Linux', /(Linux)|(X11)/],
    ['Mac OS', /(Mac_PowerPC)|(Macintosh)/],
    ['QNX', /QNX/],
    ['BeOS', /BeOS/],
    ['OS/2', /OS\/2/],
];
function detect(userAgent) {
    if (!!userAgent) {
        return parseUserAgent(userAgent);
    }
    if (typeof document === 'undefined' &&
        typeof navigator !== 'undefined' &&
        navigator.product === 'ReactNative') {
        return new ReactNativeInfo();
    }
    if (typeof navigator !== 'undefined') {
        return parseUserAgent(navigator.userAgent);
    }
    return getNodeVersion();
}
function matchUserAgent(ua) {
    // opted for using reduce here rather than Array#first with a regex.test call
    // this is primarily because using the reduce we only perform the regex
    // execution once rather than once for the test and for the exec again below
    // probably something that needs to be benchmarked though
    return (ua !== '' &&
        userAgentRules.reduce(function (matched, _a) {
            var browser = _a[0], regex = _a[1];
            if (matched) {
                return matched;
            }
            var uaMatch = regex.exec(ua);
            return !!uaMatch && [browser, uaMatch];
        }, false));
}
function browserName(ua) {
    var data = matchUserAgent(ua);
    return data ? data[0] : null;
}
function parseUserAgent(ua) {
    var matchedRule = matchUserAgent(ua);
    if (!matchedRule) {
        return null;
    }
    var name = matchedRule[0], match = matchedRule[1];
    if (name === 'searchbot') {
        return new BotInfo();
    }
    // Do not use RegExp for split operation as some browser do not support it (See: http://blog.stevenlevithan.com/archives/cross-browser-split)
    var versionParts = match[1] && match[1].split('.').join('_').split('_').slice(0, 3);
    if (versionParts) {
        if (versionParts.length < REQUIRED_VERSION_PARTS) {
            versionParts = __spreadArray(__spreadArray([], versionParts, true), createVersionParts(REQUIRED_VERSION_PARTS - versionParts.length), true);
        }
    }
    else {
        versionParts = [];
    }
    var version = versionParts.join('.');
    var os = detectOS(ua);
    var searchBotMatch = SEARCHBOT_OS_REGEX.exec(ua);
    if (searchBotMatch && searchBotMatch[1]) {
        return new SearchBotDeviceInfo(name, version, os, searchBotMatch[1]);
    }
    return new BrowserInfo(name, version, os);
}
function detectOS(ua) {
    for (var ii = 0, count = operatingSystemRules.length; ii < count; ii++) {
        var _a = operatingSystemRules[ii], os = _a[0], regex = _a[1];
        var match = regex.exec(ua);
        if (match) {
            return os;
        }
    }
    return null;
}
function getNodeVersion() {
    var isNode = typeof process !== 'undefined' && process.version;
    return isNode ? new NodeInfo(process.version.slice(1)) : null;
}
function createVersionParts(count) {
    var output = [];
    for (var ii = 0; ii < count; ii++) {
        output.push('0');
    }
    return output;
}

// EXTERNAL MODULE: ./node_modules/@walletconnect/time/dist/cjs/index.js
var cjs = __webpack_require__(88900);
// EXTERNAL MODULE: ./node_modules/@walletconnect/window-getters/dist/cjs/index.js
var dist_cjs = __webpack_require__(38196);
// EXTERNAL MODULE: ./node_modules/@walletconnect/window-metadata/dist/cjs/index.js
var window_metadata_dist_cjs = __webpack_require__(42063);
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/errors/version.js
const version = '2.23.2';
//# sourceMappingURL=version.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/errors/base.js

let errorConfig = {
    getDocsUrl: ({ docsBaseUrl, docsPath = '', docsSlug, }) => docsPath
        ? `${docsBaseUrl ?? 'https://viem.sh'}${docsPath}${docsSlug ? `#${docsSlug}` : ''}`
        : undefined,
    version: `viem@${version}`,
};
function setErrorConfig(config) {
    errorConfig = config;
}
class BaseError extends Error {
    constructor(shortMessage, args = {}) {
        const details = (() => {
            if (args.cause instanceof BaseError)
                return args.cause.details;
            if (args.cause?.message)
                return args.cause.message;
            return args.details;
        })();
        const docsPath = (() => {
            if (args.cause instanceof BaseError)
                return args.cause.docsPath || args.docsPath;
            return args.docsPath;
        })();
        const docsUrl = errorConfig.getDocsUrl?.({ ...args, docsPath });
        const message = [
            shortMessage || 'An error occurred.',
            '',
            ...(args.metaMessages ? [...args.metaMessages, ''] : []),
            ...(docsUrl ? [`Docs: ${docsUrl}`] : []),
            ...(details ? [`Details: ${details}`] : []),
            ...(errorConfig.version ? [`Version: ${errorConfig.version}`] : []),
        ].join('\n');
        super(message, args.cause ? { cause: args.cause } : undefined);
        Object.defineProperty(this, "details", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "docsPath", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "metaMessages", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "shortMessage", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "version", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'BaseError'
        });
        this.details = details;
        this.docsPath = docsPath;
        this.metaMessages = args.metaMessages;
        this.name = args.name ?? this.name;
        this.shortMessage = shortMessage;
        this.version = version;
    }
    walk(fn) {
        return walk(this, fn);
    }
}
function walk(err, fn) {
    if (fn?.(err))
        return err;
    if (err &&
        typeof err === 'object' &&
        'cause' in err &&
        err.cause !== undefined)
        return walk(err.cause, fn);
    return fn ? null : err;
}
//# sourceMappingURL=base.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
    if (!value)
        return false;
    if (typeof value !== 'string')
        return false;
    return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith('0x');
}
//# sourceMappingURL=isHex.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/errors/data.js

class SliceOffsetOutOfBoundsError extends BaseError {
    constructor({ offset, position, size, }) {
        super(`Slice ${position === 'start' ? 'starting' : 'ending'} at offset "${offset}" is out-of-bounds (size: ${size}).`, { name: 'SliceOffsetOutOfBoundsError' });
    }
}
class SizeExceedsPaddingSizeError extends BaseError {
    constructor({ size, targetSize, type, }) {
        super(`${type.charAt(0).toUpperCase()}${type
            .slice(1)
            .toLowerCase()} size (${size}) exceeds padding size (${targetSize}).`, { name: 'SizeExceedsPaddingSizeError' });
    }
}
class InvalidBytesLengthError extends BaseError {
    constructor({ size, targetSize, type, }) {
        super(`${type.charAt(0).toUpperCase()}${type
            .slice(1)
            .toLowerCase()} is expected to be ${targetSize} ${type} long, but is ${size} ${type} long.`, { name: 'InvalidBytesLengthError' });
    }
}
//# sourceMappingURL=data.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/data/pad.js

function pad(hexOrBytes, { dir, size = 32 } = {}) {
    if (typeof hexOrBytes === 'string')
        return padHex(hexOrBytes, { dir, size });
    return padBytes(hexOrBytes, { dir, size });
}
function padHex(hex_, { dir, size = 32 } = {}) {
    if (size === null)
        return hex_;
    const hex = hex_.replace('0x', '');
    if (hex.length > size * 2)
        throw new SizeExceedsPaddingSizeError({
            size: Math.ceil(hex.length / 2),
            targetSize: size,
            type: 'hex',
        });
    return `0x${hex[dir === 'right' ? 'padEnd' : 'padStart'](size * 2, '0')}`;
}
function padBytes(bytes, { dir, size = 32 } = {}) {
    if (size === null)
        return bytes;
    if (bytes.length > size)
        throw new SizeExceedsPaddingSizeError({
            size: bytes.length,
            targetSize: size,
            type: 'bytes',
        });
    const paddedBytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        const padEnd = dir === 'right';
        paddedBytes[padEnd ? i : size - i - 1] =
            bytes[padEnd ? i : bytes.length - i - 1];
    }
    return paddedBytes;
}
//# sourceMappingURL=pad.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/errors/encoding.js

class IntegerOutOfRangeError extends BaseError {
    constructor({ max, min, signed, size, value, }) {
        super(`Number "${value}" is not in safe ${size ? `${size * 8}-bit ${signed ? 'signed' : 'unsigned'} ` : ''}integer range ${max ? `(${min} to ${max})` : `(above ${min})`}`, { name: 'IntegerOutOfRangeError' });
    }
}
class InvalidBytesBooleanError extends BaseError {
    constructor(bytes) {
        super(`Bytes value "${bytes}" is not a valid boolean. The bytes array must contain a single byte of either a 0 or 1 value.`, {
            name: 'InvalidBytesBooleanError',
        });
    }
}
class encoding_InvalidHexBooleanError extends BaseError {
    constructor(hex) {
        super(`Hex value "${hex}" is not a valid boolean. The hex value must be "0x0" (false) or "0x1" (true).`, { name: 'InvalidHexBooleanError' });
    }
}
class InvalidHexValueError extends BaseError {
    constructor(value) {
        super(`Hex value "${value}" is an odd length (${value.length}). It must be an even length.`, { name: 'InvalidHexValueError' });
    }
}
class SizeOverflowError extends BaseError {
    constructor({ givenSize, maxSize }) {
        super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: 'SizeOverflowError' });
    }
}
//# sourceMappingURL=encoding.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/data/size.js

/**
 * @description Retrieves the size of the value (in bytes).
 *
 * @param value The value (hex or byte array) to retrieve the size of.
 * @returns The size of the value (in bytes).
 */
function size_size(value) {
    if (isHex(value, { strict: false }))
        return Math.ceil((value.length - 2) / 2);
    return value.length;
}
//# sourceMappingURL=size.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/encoding/fromHex.js




function assertSize(hexOrBytes, { size }) {
    if (size_size(hexOrBytes) > size)
        throw new SizeOverflowError({
            givenSize: size_size(hexOrBytes),
            maxSize: size,
        });
}
/**
 * Decodes a hex string into a string, number, bigint, boolean, or byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/fromHex
 * - Example: https://viem.sh/docs/utilities/fromHex#usage
 *
 * @param hex Hex string to decode.
 * @param toOrOpts Type to convert to or options.
 * @returns Decoded value.
 *
 * @example
 * import { fromHex } from 'viem'
 * const data = fromHex('0x1a4', 'number')
 * // 420
 *
 * @example
 * import { fromHex } from 'viem'
 * const data = fromHex('0x48656c6c6f20576f726c6421', 'string')
 * // 'Hello world'
 *
 * @example
 * import { fromHex } from 'viem'
 * const data = fromHex('0x48656c6c6f20576f726c64210000000000000000000000000000000000000000', {
 *   size: 32,
 *   to: 'string'
 * })
 * // 'Hello world'
 */
function fromHex(hex, toOrOpts) {
    const opts = typeof toOrOpts === 'string' ? { to: toOrOpts } : toOrOpts;
    const to = opts.to;
    if (to === 'number')
        return hexToNumber(hex, opts);
    if (to === 'bigint')
        return hexToBigInt(hex, opts);
    if (to === 'string')
        return hexToString(hex, opts);
    if (to === 'boolean')
        return hexToBool(hex, opts);
    return hexToBytes(hex, opts);
}
/**
 * Decodes a hex value into a bigint.
 *
 * - Docs: https://viem.sh/docs/utilities/fromHex#hextobigint
 *
 * @param hex Hex value to decode.
 * @param opts Options.
 * @returns BigInt value.
 *
 * @example
 * import { hexToBigInt } from 'viem'
 * const data = hexToBigInt('0x1a4', { signed: true })
 * // 420n
 *
 * @example
 * import { hexToBigInt } from 'viem'
 * const data = hexToBigInt('0x00000000000000000000000000000000000000000000000000000000000001a4', { size: 32 })
 * // 420n
 */
function hexToBigInt(hex, opts = {}) {
    const { signed } = opts;
    if (opts.size)
        assertSize(hex, { size: opts.size });
    const value = BigInt(hex);
    if (!signed)
        return value;
    const size = (hex.length - 2) / 2;
    const max = (1n << (BigInt(size) * 8n - 1n)) - 1n;
    if (value <= max)
        return value;
    return value - BigInt(`0x${'f'.padStart(size * 2, 'f')}`) - 1n;
}
/**
 * Decodes a hex value into a boolean.
 *
 * - Docs: https://viem.sh/docs/utilities/fromHex#hextobool
 *
 * @param hex Hex value to decode.
 * @param opts Options.
 * @returns Boolean value.
 *
 * @example
 * import { hexToBool } from 'viem'
 * const data = hexToBool('0x01')
 * // true
 *
 * @example
 * import { hexToBool } from 'viem'
 * const data = hexToBool('0x0000000000000000000000000000000000000000000000000000000000000001', { size: 32 })
 * // true
 */
function hexToBool(hex_, opts = {}) {
    let hex = hex_;
    if (opts.size) {
        assertSize(hex, { size: opts.size });
        hex = trim(hex);
    }
    if (trim(hex) === '0x00')
        return false;
    if (trim(hex) === '0x01')
        return true;
    throw new InvalidHexBooleanError(hex);
}
/**
 * Decodes a hex string into a number.
 *
 * - Docs: https://viem.sh/docs/utilities/fromHex#hextonumber
 *
 * @param hex Hex value to decode.
 * @param opts Options.
 * @returns Number value.
 *
 * @example
 * import { hexToNumber } from 'viem'
 * const data = hexToNumber('0x1a4')
 * // 420
 *
 * @example
 * import { hexToNumber } from 'viem'
 * const data = hexToBigInt('0x00000000000000000000000000000000000000000000000000000000000001a4', { size: 32 })
 * // 420
 */
function hexToNumber(hex, opts = {}) {
    return Number(hexToBigInt(hex, opts));
}
/**
 * Decodes a hex value into a UTF-8 string.
 *
 * - Docs: https://viem.sh/docs/utilities/fromHex#hextostring
 *
 * @param hex Hex value to decode.
 * @param opts Options.
 * @returns String value.
 *
 * @example
 * import { hexToString } from 'viem'
 * const data = hexToString('0x48656c6c6f20576f726c6421')
 * // 'Hello world!'
 *
 * @example
 * import { hexToString } from 'viem'
 * const data = hexToString('0x48656c6c6f20576f726c64210000000000000000000000000000000000000000', {
 *  size: 32,
 * })
 * // 'Hello world'
 */
function hexToString(hex, opts = {}) {
    let bytes = hexToBytes(hex);
    if (opts.size) {
        assertSize(bytes, { size: opts.size });
        bytes = trim(bytes, { dir: 'right' });
    }
    return new TextDecoder().decode(bytes);
}
//# sourceMappingURL=fromHex.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/encoding/toHex.js



const hexes = /*#__PURE__*/ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, '0'));
/**
 * Encodes a string, number, bigint, or ByteArray into a hex string
 *
 * - Docs: https://viem.sh/docs/utilities/toHex
 * - Example: https://viem.sh/docs/utilities/toHex#usage
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Hex value.
 *
 * @example
 * import { toHex } from 'viem'
 * const data = toHex('Hello world')
 * // '0x48656c6c6f20776f726c6421'
 *
 * @example
 * import { toHex } from 'viem'
 * const data = toHex(420)
 * // '0x1a4'
 *
 * @example
 * import { toHex } from 'viem'
 * const data = toHex('Hello world', { size: 32 })
 * // '0x48656c6c6f20776f726c64210000000000000000000000000000000000000000'
 */
function toHex(value, opts = {}) {
    if (typeof value === 'number' || typeof value === 'bigint')
        return numberToHex(value, opts);
    if (typeof value === 'string') {
        return stringToHex(value, opts);
    }
    if (typeof value === 'boolean')
        return boolToHex(value, opts);
    return bytesToHex(value, opts);
}
/**
 * Encodes a boolean into a hex string
 *
 * - Docs: https://viem.sh/docs/utilities/toHex#booltohex
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Hex value.
 *
 * @example
 * import { boolToHex } from 'viem'
 * const data = boolToHex(true)
 * // '0x1'
 *
 * @example
 * import { boolToHex } from 'viem'
 * const data = boolToHex(false)
 * // '0x0'
 *
 * @example
 * import { boolToHex } from 'viem'
 * const data = boolToHex(true, { size: 32 })
 * // '0x0000000000000000000000000000000000000000000000000000000000000001'
 */
function boolToHex(value, opts = {}) {
    const hex = `0x${Number(value)}`;
    if (typeof opts.size === 'number') {
        assertSize(hex, { size: opts.size });
        return pad(hex, { size: opts.size });
    }
    return hex;
}
/**
 * Encodes a bytes array into a hex string
 *
 * - Docs: https://viem.sh/docs/utilities/toHex#bytestohex
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Hex value.
 *
 * @example
 * import { bytesToHex } from 'viem'
 * const data = bytesToHex(Uint8Array.from([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
 * // '0x48656c6c6f20576f726c6421'
 *
 * @example
 * import { bytesToHex } from 'viem'
 * const data = bytesToHex(Uint8Array.from([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33]), { size: 32 })
 * // '0x48656c6c6f20576f726c64210000000000000000000000000000000000000000'
 */
function bytesToHex(value, opts = {}) {
    let string = '';
    for (let i = 0; i < value.length; i++) {
        string += hexes[value[i]];
    }
    const hex = `0x${string}`;
    if (typeof opts.size === 'number') {
        assertSize(hex, { size: opts.size });
        return pad(hex, { dir: 'right', size: opts.size });
    }
    return hex;
}
/**
 * Encodes a number or bigint into a hex string
 *
 * - Docs: https://viem.sh/docs/utilities/toHex#numbertohex
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Hex value.
 *
 * @example
 * import { numberToHex } from 'viem'
 * const data = numberToHex(420)
 * // '0x1a4'
 *
 * @example
 * import { numberToHex } from 'viem'
 * const data = numberToHex(420, { size: 32 })
 * // '0x00000000000000000000000000000000000000000000000000000000000001a4'
 */
function numberToHex(value_, opts = {}) {
    const { signed, size } = opts;
    const value = BigInt(value_);
    let maxValue;
    if (size) {
        if (signed)
            maxValue = (1n << (BigInt(size) * 8n - 1n)) - 1n;
        else
            maxValue = 2n ** (BigInt(size) * 8n) - 1n;
    }
    else if (typeof value_ === 'number') {
        maxValue = BigInt(Number.MAX_SAFE_INTEGER);
    }
    const minValue = typeof maxValue === 'bigint' && signed ? -maxValue - 1n : 0;
    if ((maxValue && value > maxValue) || value < minValue) {
        const suffix = typeof value_ === 'bigint' ? 'n' : '';
        throw new IntegerOutOfRangeError({
            max: maxValue ? `${maxValue}${suffix}` : undefined,
            min: `${minValue}${suffix}`,
            signed,
            size,
            value: `${value_}${suffix}`,
        });
    }
    const hex = `0x${(signed && value < 0 ? (1n << BigInt(size * 8)) + BigInt(value) : value).toString(16)}`;
    if (size)
        return pad(hex, { size });
    return hex;
}
const encoder = /*#__PURE__*/ new TextEncoder();
/**
 * Encodes a UTF-8 string into a hex string
 *
 * - Docs: https://viem.sh/docs/utilities/toHex#stringtohex
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Hex value.
 *
 * @example
 * import { stringToHex } from 'viem'
 * const data = stringToHex('Hello World!')
 * // '0x48656c6c6f20576f726c6421'
 *
 * @example
 * import { stringToHex } from 'viem'
 * const data = stringToHex('Hello World!', { size: 32 })
 * // '0x48656c6c6f20576f726c64210000000000000000000000000000000000000000'
 */
function stringToHex(value_, opts = {}) {
    const value = encoder.encode(value_);
    return bytesToHex(value, opts);
}
//# sourceMappingURL=toHex.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/encoding/toBytes.js





const toBytes_encoder = /*#__PURE__*/ new TextEncoder();
/**
 * Encodes a UTF-8 string, hex value, bigint, number or boolean to a byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/toBytes
 * - Example: https://viem.sh/docs/utilities/toBytes#usage
 *
 * @param value Value to encode.
 * @param opts Options.
 * @returns Byte array value.
 *
 * @example
 * import { toBytes } from 'viem'
 * const data = toBytes('Hello world')
 * // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
 *
 * @example
 * import { toBytes } from 'viem'
 * const data = toBytes(420)
 * // Uint8Array([1, 164])
 *
 * @example
 * import { toBytes } from 'viem'
 * const data = toBytes(420, { size: 4 })
 * // Uint8Array([0, 0, 1, 164])
 */
function toBytes(value, opts = {}) {
    if (typeof value === 'number' || typeof value === 'bigint')
        return numberToBytes(value, opts);
    if (typeof value === 'boolean')
        return boolToBytes(value, opts);
    if (isHex(value))
        return toBytes_hexToBytes(value, opts);
    return stringToBytes(value, opts);
}
/**
 * Encodes a boolean into a byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/toBytes#booltobytes
 *
 * @param value Boolean value to encode.
 * @param opts Options.
 * @returns Byte array value.
 *
 * @example
 * import { boolToBytes } from 'viem'
 * const data = boolToBytes(true)
 * // Uint8Array([1])
 *
 * @example
 * import { boolToBytes } from 'viem'
 * const data = boolToBytes(true, { size: 32 })
 * // Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
 */
function boolToBytes(value, opts = {}) {
    const bytes = new Uint8Array(1);
    bytes[0] = Number(value);
    if (typeof opts.size === 'number') {
        assertSize(bytes, { size: opts.size });
        return pad(bytes, { size: opts.size });
    }
    return bytes;
}
// We use very optimized technique to convert hex string to byte array
const charCodeMap = {
    zero: 48,
    nine: 57,
    A: 65,
    F: 70,
    a: 97,
    f: 102,
};
function charCodeToBase16(char) {
    if (char >= charCodeMap.zero && char <= charCodeMap.nine)
        return char - charCodeMap.zero;
    if (char >= charCodeMap.A && char <= charCodeMap.F)
        return char - (charCodeMap.A - 10);
    if (char >= charCodeMap.a && char <= charCodeMap.f)
        return char - (charCodeMap.a - 10);
    return undefined;
}
/**
 * Encodes a hex string into a byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/toBytes#hextobytes
 *
 * @param hex Hex string to encode.
 * @param opts Options.
 * @returns Byte array value.
 *
 * @example
 * import { hexToBytes } from 'viem'
 * const data = hexToBytes('0x48656c6c6f20776f726c6421')
 * // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
 *
 * @example
 * import { hexToBytes } from 'viem'
 * const data = hexToBytes('0x48656c6c6f20776f726c6421', { size: 32 })
 * // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
 */
function toBytes_hexToBytes(hex_, opts = {}) {
    let hex = hex_;
    if (opts.size) {
        assertSize(hex, { size: opts.size });
        hex = pad(hex, { dir: 'right', size: opts.size });
    }
    let hexString = hex.slice(2);
    if (hexString.length % 2)
        hexString = `0${hexString}`;
    const length = hexString.length / 2;
    const bytes = new Uint8Array(length);
    for (let index = 0, j = 0; index < length; index++) {
        const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
        const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
        if (nibbleLeft === undefined || nibbleRight === undefined) {
            throw new BaseError(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
        }
        bytes[index] = nibbleLeft * 16 + nibbleRight;
    }
    return bytes;
}
/**
 * Encodes a number into a byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/toBytes#numbertobytes
 *
 * @param value Number to encode.
 * @param opts Options.
 * @returns Byte array value.
 *
 * @example
 * import { numberToBytes } from 'viem'
 * const data = numberToBytes(420)
 * // Uint8Array([1, 164])
 *
 * @example
 * import { numberToBytes } from 'viem'
 * const data = numberToBytes(420, { size: 4 })
 * // Uint8Array([0, 0, 1, 164])
 */
function numberToBytes(value, opts) {
    const hex = numberToHex(value, opts);
    return toBytes_hexToBytes(hex);
}
/**
 * Encodes a UTF-8 string into a byte array.
 *
 * - Docs: https://viem.sh/docs/utilities/toBytes#stringtobytes
 *
 * @param value String to encode.
 * @param opts Options.
 * @returns Byte array value.
 *
 * @example
 * import { stringToBytes } from 'viem'
 * const data = stringToBytes('Hello world!')
 * // Uint8Array([72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33])
 *
 * @example
 * import { stringToBytes } from 'viem'
 * const data = stringToBytes('Hello world!', { size: 32 })
 * // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
 */
function stringToBytes(value, opts = {}) {
    const bytes = toBytes_encoder.encode(value);
    if (typeof opts.size === 'number') {
        assertSize(bytes, { size: opts.size });
        return pad(bytes, { dir: 'right', size: opts.size });
    }
    return bytes;
}
//# sourceMappingURL=toBytes.js.map
// EXTERNAL MODULE: ./node_modules/@noble/hashes/esm/sha3.js + 1 modules
var sha3 = __webpack_require__(63741);
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/hash/keccak256.js




function keccak256(value, to_) {
    const to = to_ || 'hex';
    const bytes = (0,sha3/* keccak_256 */.lY)(isHex(value, { strict: false }) ? toBytes(value) : value);
    if (to === 'bytes')
        return bytes;
    return toHex(bytes);
}
//# sourceMappingURL=keccak256.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/lru.js
/**
 * Map with a LRU (Least recently used) policy.
 *
 * @link https://en.wikipedia.org/wiki/Cache_replacement_policies#LRU
 */
class LruMap extends Map {
    constructor(size) {
        super();
        Object.defineProperty(this, "maxSize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.maxSize = size;
    }
    get(key) {
        const value = super.get(key);
        if (super.has(key) && value !== undefined) {
            this.delete(key);
            super.set(key, value);
        }
        return value;
    }
    set(key, value) {
        super.set(key, value);
        if (this.maxSize && this.size > this.maxSize) {
            const firstKey = this.keys().next().value;
            if (firstKey)
                this.delete(firstKey);
        }
        return this;
    }
}
//# sourceMappingURL=lru.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/address/getAddress.js





const checksumAddressCache = /*#__PURE__*/ new LruMap(8192);
function checksumAddress(address_, 
/**
 * Warning: EIP-1191 checksum addresses are generally not backwards compatible with the
 * wider Ethereum ecosystem, meaning it will break when validated against an application/tool
 * that relies on EIP-55 checksum encoding (checksum without chainId).
 *
 * It is highly recommended to not use this feature unless you
 * know what you are doing.
 *
 * See more: https://github.com/ethereum/EIPs/issues/1121
 */
chainId) {
    if (checksumAddressCache.has(`${address_}.${chainId}`))
        return checksumAddressCache.get(`${address_}.${chainId}`);
    const hexAddress = chainId
        ? `${chainId}${address_.toLowerCase()}`
        : address_.substring(2).toLowerCase();
    const hash = keccak256(stringToBytes(hexAddress), 'bytes');
    const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split('');
    for (let i = 0; i < 40; i += 2) {
        if (hash[i >> 1] >> 4 >= 8 && address[i]) {
            address[i] = address[i].toUpperCase();
        }
        if ((hash[i >> 1] & 0x0f) >= 8 && address[i + 1]) {
            address[i + 1] = address[i + 1].toUpperCase();
        }
    }
    const result = `0x${address.join('')}`;
    checksumAddressCache.set(`${address_}.${chainId}`, result);
    return result;
}
function getAddress(address, 
/**
 * Warning: EIP-1191 checksum addresses are generally not backwards compatible with the
 * wider Ethereum ecosystem, meaning it will break when validated against an application/tool
 * that relies on EIP-55 checksum encoding (checksum without chainId).
 *
 * It is highly recommended to not use this feature unless you
 * know what you are doing.
 *
 * See more: https://github.com/ethereum/EIPs/issues/1121
 */
chainId) {
    if (!isAddress(address, { strict: false }))
        throw new InvalidAddressError({ address });
    return checksumAddress(address, chainId);
}
//# sourceMappingURL=getAddress.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/accounts/utils/publicKeyToAddress.js


/**
 * @description Converts an ECDSA public key to an address.
 *
 * @param publicKey The public key to convert.
 *
 * @returns The address.
 */
function publicKeyToAddress(publicKey) {
    const address = keccak256(`0x${publicKey.substring(4)}`).substring(26);
    return checksumAddress(`0x${address}`);
}
//# sourceMappingURL=publicKeyToAddress.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/signature/recoverPublicKey.js



async function recoverPublicKey({ hash, signature, }) {
    const hashHex = isHex(hash) ? hash : toHex(hash);
    const { secp256k1 } = await Promise.resolve(/* import() */).then(__webpack_require__.bind(__webpack_require__, 20808));
    const signature_ = (() => {
        // typeof signature: `Signature`
        if (typeof signature === 'object' && 'r' in signature && 's' in signature) {
            const { r, s, v, yParity } = signature;
            const yParityOrV = Number(yParity ?? v);
            const recoveryBit = toRecoveryBit(yParityOrV);
            return new secp256k1.Signature(hexToBigInt(r), hexToBigInt(s)).addRecoveryBit(recoveryBit);
        }
        // typeof signature: `Hex | ByteArray`
        const signatureHex = isHex(signature) ? signature : toHex(signature);
        const yParityOrV = hexToNumber(`0x${signatureHex.slice(130)}`);
        const recoveryBit = toRecoveryBit(yParityOrV);
        return secp256k1.Signature.fromCompact(signatureHex.substring(2, 130)).addRecoveryBit(recoveryBit);
    })();
    const publicKey = signature_
        .recoverPublicKey(hashHex.substring(2))
        .toHex(false);
    return `0x${publicKey}`;
}
function toRecoveryBit(yParityOrV) {
    if (yParityOrV === 0 || yParityOrV === 1)
        return yParityOrV;
    if (yParityOrV === 27)
        return 0;
    if (yParityOrV === 28)
        return 1;
    throw new Error('Invalid yParityOrV value');
}
//# sourceMappingURL=recoverPublicKey.js.map
;// ./node_modules/@walletconnect/utils/node_modules/viem/_esm/utils/signature/recoverAddress.js


async function recoverAddress({ hash, signature, }) {
    return publicKeyToAddress(await recoverPublicKey({ hash: hash, signature }));
}
//# sourceMappingURL=recoverAddress.js.map
;// ./node_modules/base-x/src/esm/index.js
// base-x encoding / decoding
// Copyright (c) 2018 base-x contributors
// Copyright (c) 2014-2018 The Bitcoin Core developers (base58.cpp)
// Distributed under the MIT software license, see the accompanying
// file LICENSE or http://www.opensource.org/licenses/mit-license.php.
function base (ALPHABET) {
  if (ALPHABET.length >= 255) { throw new TypeError('Alphabet too long') }
  const BASE_MAP = new Uint8Array(256)
  for (let j = 0; j < BASE_MAP.length; j++) {
    BASE_MAP[j] = 255
  }
  for (let i = 0; i < ALPHABET.length; i++) {
    const x = ALPHABET.charAt(i)
    const xc = x.charCodeAt(0)
    if (BASE_MAP[xc] !== 255) { throw new TypeError(x + ' is ambiguous') }
    BASE_MAP[xc] = i
  }
  const BASE = ALPHABET.length
  const LEADER = ALPHABET.charAt(0)
  const FACTOR = Math.log(BASE) / Math.log(256) // log(BASE) / log(256), rounded up
  const iFACTOR = Math.log(256) / Math.log(BASE) // log(256) / log(BASE), rounded up
  function encode (source) {
    // eslint-disable-next-line no-empty
    if (source instanceof Uint8Array) { } else if (ArrayBuffer.isView(source)) {
      source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    } else if (Array.isArray(source)) {
      source = Uint8Array.from(source)
    }
    if (!(source instanceof Uint8Array)) { throw new TypeError('Expected Uint8Array') }
    if (source.length === 0) { return '' }
    // Skip & count leading zeroes.
    let zeroes = 0
    let length = 0
    let pbegin = 0
    const pend = source.length
    while (pbegin !== pend && source[pbegin] === 0) {
      pbegin++
      zeroes++
    }
    // Allocate enough space in big-endian base58 representation.
    const size = ((pend - pbegin) * iFACTOR + 1) >>> 0
    const b58 = new Uint8Array(size)
    // Process the bytes.
    while (pbegin !== pend) {
      let carry = source[pbegin]
      // Apply "b58 = b58 * 256 + ch".
      let i = 0
      for (let it1 = size - 1; (carry !== 0 || i < length) && (it1 !== -1); it1--, i++) {
        carry += (256 * b58[it1]) >>> 0
        b58[it1] = (carry % BASE) >>> 0
        carry = (carry / BASE) >>> 0
      }
      if (carry !== 0) { throw new Error('Non-zero carry') }
      length = i
      pbegin++
    }
    // Skip leading zeroes in base58 result.
    let it2 = size - length
    while (it2 !== size && b58[it2] === 0) {
      it2++
    }
    // Translate the result into a string.
    let str = LEADER.repeat(zeroes)
    for (; it2 < size; ++it2) { str += ALPHABET.charAt(b58[it2]) }
    return str
  }
  function decodeUnsafe (source) {
    if (typeof source !== 'string') { throw new TypeError('Expected String') }
    if (source.length === 0) { return new Uint8Array() }
    let psz = 0
    // Skip and count leading '1's.
    let zeroes = 0
    let length = 0
    while (source[psz] === LEADER) {
      zeroes++
      psz++
    }
    // Allocate enough space in big-endian base256 representation.
    const size = (((source.length - psz) * FACTOR) + 1) >>> 0 // log(58) / log(256), rounded up.
    const b256 = new Uint8Array(size)
    // Process the characters.
    while (psz < source.length) {
      // Find code of next character
      const charCode = source.charCodeAt(psz)
      // Base map can not be indexed using char code
      if (charCode > 255) { return }
      // Decode character
      let carry = BASE_MAP[charCode]
      // Invalid character
      if (carry === 255) { return }
      let i = 0
      for (let it3 = size - 1; (carry !== 0 || i < length) && (it3 !== -1); it3--, i++) {
        carry += (BASE * b256[it3]) >>> 0
        b256[it3] = (carry % 256) >>> 0
        carry = (carry / 256) >>> 0
      }
      if (carry !== 0) { throw new Error('Non-zero carry') }
      length = i
      psz++
    }
    // Skip leading zeroes in b256.
    let it4 = size - length
    while (it4 !== size && b256[it4] === 0) {
      it4++
    }
    const vch = new Uint8Array(zeroes + (size - it4))
    let j = zeroes
    while (it4 !== size) {
      vch[j++] = b256[it4++]
    }
    return vch
  }
  function decode (string) {
    const buffer = decodeUnsafe(string)
    if (buffer) { return buffer }
    throw new Error('Non-base' + BASE + ' character')
  }
  return {
    encode,
    decodeUnsafe,
    decode
  }
}
/* harmony default export */ const esm = (base);

;// ./node_modules/bs58/src/esm/index.js

var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/* harmony default export */ const src_esm = (esm(ALPHABET));

;// ./node_modules/@walletconnect/safe-json/dist/esm/index.js
const JSONStringify = data => JSON.stringify(data, (_, value) => typeof value === "bigint" ? value.toString() + "n" : value);
const JSONParse = json => {
    const numbersBiggerThanMaxInt = /([\[:])?(\d{17,}|(?:[9](?:[1-9]07199254740991|0[1-9]7199254740991|00[8-9]199254740991|007[2-9]99254740991|007199[3-9]54740991|0071992[6-9]4740991|00719925[5-9]740991|007199254[8-9]40991|0071992547[5-9]0991|00719925474[1-9]991|00719925474099[2-9])))([,\}\]])/g;
    const serializedData = json.replace(numbersBiggerThanMaxInt, "$1\"$2n\"$3");
    return JSON.parse(serializedData, (_, value) => {
        const isCustomFormatBigInt = typeof value === "string" && value.match(/^\d+n$/);
        if (isCustomFormatBigInt)
            return BigInt(value.substring(0, value.length - 1));
        return value;
    });
};
function safeJsonParse(value) {
    if (typeof value !== "string") {
        throw new Error(`Cannot safe json parse value of type ${typeof value}`);
    }
    try {
        return JSONParse(value);
    }
    catch (_a) {
        return value;
    }
}
function safeJsonStringify(value) {
    return typeof value === "string" ? value : JSONStringify(value) || "";
}
//# sourceMappingURL=index.js.map
;// ./node_modules/@walletconnect/relay-auth/dist/index.es.js
function En(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function fe(t,...e){if(!En(t))throw new Error("Uint8Array expected");if(e.length>0&&!e.includes(t.length))throw new Error("Uint8Array expected of length "+e+", got length="+t.length)}function De(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function gn(t,e){fe(t);const n=e.outputLen;if(t.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}const it=typeof globalThis=="object"&&"crypto"in globalThis?globalThis.crypto:void 0;/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */const _t=t=>new DataView(t.buffer,t.byteOffset,t.byteLength);function yn(t){if(typeof t!="string")throw new Error("utf8ToBytes expected string, got "+typeof t);return new Uint8Array(new TextEncoder().encode(t))}function de(t){return typeof t=="string"&&(t=yn(t)),fe(t),t}class xn{clone(){return this._cloneInto()}}function Bn(t){const e=r=>t().update(de(r)).digest(),n=t();return e.outputLen=n.outputLen,e.blockLen=n.blockLen,e.create=()=>t(),e}function he(t=32){if(it&&typeof it.getRandomValues=="function")return it.getRandomValues(new Uint8Array(t));if(it&&typeof it.randomBytes=="function")return it.randomBytes(t);throw new Error("crypto.getRandomValues must be defined")}function Cn(t,e,n,r){if(typeof t.setBigUint64=="function")return t.setBigUint64(e,n,r);const o=BigInt(32),s=BigInt(4294967295),a=Number(n>>o&s),u=Number(n&s),i=r?4:0,D=r?0:4;t.setUint32(e+i,a,r),t.setUint32(e+D,u,r)}class An extends xn{constructor(e,n,r,o){super(),this.blockLen=e,this.outputLen=n,this.padOffset=r,this.isLE=o,this.finished=!1,this.length=0,this.pos=0,this.destroyed=!1,this.buffer=new Uint8Array(e),this.view=_t(this.buffer)}update(e){De(this);const{view:n,buffer:r,blockLen:o}=this;e=de(e);const s=e.length;for(let a=0;a<s;){const u=Math.min(o-this.pos,s-a);if(u===o){const i=_t(e);for(;o<=s-a;a+=o)this.process(i,a);continue}r.set(e.subarray(a,a+u),this.pos),this.pos+=u,a+=u,this.pos===o&&(this.process(n,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){De(this),gn(e,this),this.finished=!0;const{buffer:n,view:r,blockLen:o,isLE:s}=this;let{pos:a}=this;n[a++]=128,this.buffer.subarray(a).fill(0),this.padOffset>o-a&&(this.process(r,0),a=0);for(let l=a;l<o;l++)n[l]=0;Cn(r,o-8,BigInt(this.length*8),s),this.process(r,0);const u=_t(e),i=this.outputLen;if(i%4)throw new Error("_sha2: outputLen should be aligned to 32bit");const D=i/4,c=this.get();if(D>c.length)throw new Error("_sha2: outputLen bigger than state");for(let l=0;l<D;l++)u.setUint32(4*l,c[l],s)}digest(){const{buffer:e,outputLen:n}=this;this.digestInto(e);const r=e.slice(0,n);return this.destroy(),r}_cloneInto(e){e||(e=new this.constructor),e.set(...this.get());const{blockLen:n,buffer:r,length:o,finished:s,destroyed:a,pos:u}=this;return e.length=o,e.pos=u,e.finished=s,e.destroyed=a,o%n&&e.buffer.set(r),e}}const wt=BigInt(2**32-1),St=BigInt(32);function le(t,e=!1){return e?{h:Number(t&wt),l:Number(t>>St&wt)}:{h:Number(t>>St&wt)|0,l:Number(t&wt)|0}}function mn(t,e=!1){let n=new Uint32Array(t.length),r=new Uint32Array(t.length);for(let o=0;o<t.length;o++){const{h:s,l:a}=le(t[o],e);[n[o],r[o]]=[s,a]}return[n,r]}const _n=(t,e)=>BigInt(t>>>0)<<St|BigInt(e>>>0),Sn=(t,e,n)=>t>>>n,vn=(t,e,n)=>t<<32-n|e>>>n,In=(t,e,n)=>t>>>n|e<<32-n,Un=(t,e,n)=>t<<32-n|e>>>n,Tn=(t,e,n)=>t<<64-n|e>>>n-32,Fn=(t,e,n)=>t>>>n-32|e<<64-n,Nn=(t,e)=>e,Ln=(t,e)=>t,On=(t,e,n)=>t<<n|e>>>32-n,Hn=(t,e,n)=>e<<n|t>>>32-n,zn=(t,e,n)=>e<<n-32|t>>>64-n,Mn=(t,e,n)=>t<<n-32|e>>>64-n;function qn(t,e,n,r){const o=(e>>>0)+(r>>>0);return{h:t+n+(o/2**32|0)|0,l:o|0}}const $n=(t,e,n)=>(t>>>0)+(e>>>0)+(n>>>0),kn=(t,e,n,r)=>e+n+r+(t/2**32|0)|0,Rn=(t,e,n,r)=>(t>>>0)+(e>>>0)+(n>>>0)+(r>>>0),jn=(t,e,n,r,o)=>e+n+r+o+(t/2**32|0)|0,Zn=(t,e,n,r,o)=>(t>>>0)+(e>>>0)+(n>>>0)+(r>>>0)+(o>>>0),Gn=(t,e,n,r,o,s)=>e+n+r+o+s+(t/2**32|0)|0,x={fromBig:le,split:mn,toBig:_n,shrSH:Sn,shrSL:vn,rotrSH:In,rotrSL:Un,rotrBH:Tn,rotrBL:Fn,rotr32H:Nn,rotr32L:Ln,rotlSH:On,rotlSL:Hn,rotlBH:zn,rotlBL:Mn,add:qn,add3L:$n,add3H:kn,add4L:Rn,add4H:jn,add5H:Gn,add5L:Zn},[Vn,Yn]=(()=>x.split(["0x428a2f98d728ae22","0x7137449123ef65cd","0xb5c0fbcfec4d3b2f","0xe9b5dba58189dbbc","0x3956c25bf348b538","0x59f111f1b605d019","0x923f82a4af194f9b","0xab1c5ed5da6d8118","0xd807aa98a3030242","0x12835b0145706fbe","0x243185be4ee4b28c","0x550c7dc3d5ffb4e2","0x72be5d74f27b896f","0x80deb1fe3b1696b1","0x9bdc06a725c71235","0xc19bf174cf692694","0xe49b69c19ef14ad2","0xefbe4786384f25e3","0x0fc19dc68b8cd5b5","0x240ca1cc77ac9c65","0x2de92c6f592b0275","0x4a7484aa6ea6e483","0x5cb0a9dcbd41fbd4","0x76f988da831153b5","0x983e5152ee66dfab","0xa831c66d2db43210","0xb00327c898fb213f","0xbf597fc7beef0ee4","0xc6e00bf33da88fc2","0xd5a79147930aa725","0x06ca6351e003826f","0x142929670a0e6e70","0x27b70a8546d22ffc","0x2e1b21385c26c926","0x4d2c6dfc5ac42aed","0x53380d139d95b3df","0x650a73548baf63de","0x766a0abb3c77b2a8","0x81c2c92e47edaee6","0x92722c851482353b","0xa2bfe8a14cf10364","0xa81a664bbc423001","0xc24b8b70d0f89791","0xc76c51a30654be30","0xd192e819d6ef5218","0xd69906245565a910","0xf40e35855771202a","0x106aa07032bbd1b8","0x19a4c116b8d2d0c8","0x1e376c085141ab53","0x2748774cdf8eeb99","0x34b0bcb5e19b48a8","0x391c0cb3c5c95a63","0x4ed8aa4ae3418acb","0x5b9cca4f7763e373","0x682e6ff3d6b2b8a3","0x748f82ee5defb2fc","0x78a5636f43172f60","0x84c87814a1f0ab72","0x8cc702081a6439ec","0x90befffa23631e28","0xa4506cebde82bde9","0xbef9a3f7b2c67915","0xc67178f2e372532b","0xca273eceea26619c","0xd186b8c721c0c207","0xeada7dd6cde0eb1e","0xf57d4f7fee6ed178","0x06f067aa72176fba","0x0a637dc5a2c898a6","0x113f9804bef90dae","0x1b710b35131c471b","0x28db77f523047d84","0x32caab7b40c72493","0x3c9ebe0a15c9bebc","0x431d67c49c100d4c","0x4cc5d4becb3e42b6","0x597f299cfc657e2a","0x5fcb6fab3ad6faec","0x6c44198c4a475817"].map(t=>BigInt(t))))(),P=new Uint32Array(80),Q=new Uint32Array(80);class Jn extends An{constructor(){super(128,64,16,!1),this.Ah=1779033703,this.Al=-205731576,this.Bh=-1150833019,this.Bl=-2067093701,this.Ch=1013904242,this.Cl=-23791573,this.Dh=-1521486534,this.Dl=1595750129,this.Eh=1359893119,this.El=-1377402159,this.Fh=-1694144372,this.Fl=725511199,this.Gh=528734635,this.Gl=-79577749,this.Hh=1541459225,this.Hl=327033209}get(){const{Ah:e,Al:n,Bh:r,Bl:o,Ch:s,Cl:a,Dh:u,Dl:i,Eh:D,El:c,Fh:l,Fl:p,Gh:w,Gl:h,Hh:g,Hl:S}=this;return[e,n,r,o,s,a,u,i,D,c,l,p,w,h,g,S]}set(e,n,r,o,s,a,u,i,D,c,l,p,w,h,g,S){this.Ah=e|0,this.Al=n|0,this.Bh=r|0,this.Bl=o|0,this.Ch=s|0,this.Cl=a|0,this.Dh=u|0,this.Dl=i|0,this.Eh=D|0,this.El=c|0,this.Fh=l|0,this.Fl=p|0,this.Gh=w|0,this.Gl=h|0,this.Hh=g|0,this.Hl=S|0}process(e,n){for(let d=0;d<16;d++,n+=4)P[d]=e.getUint32(n),Q[d]=e.getUint32(n+=4);for(let d=16;d<80;d++){const m=P[d-15]|0,F=Q[d-15]|0,q=x.rotrSH(m,F,1)^x.rotrSH(m,F,8)^x.shrSH(m,F,7),z=x.rotrSL(m,F,1)^x.rotrSL(m,F,8)^x.shrSL(m,F,7),I=P[d-2]|0,O=Q[d-2]|0,ot=x.rotrSH(I,O,19)^x.rotrBH(I,O,61)^x.shrSH(I,O,6),tt=x.rotrSL(I,O,19)^x.rotrBL(I,O,61)^x.shrSL(I,O,6),st=x.add4L(z,tt,Q[d-7],Q[d-16]),at=x.add4H(st,q,ot,P[d-7],P[d-16]);P[d]=at|0,Q[d]=st|0}let{Ah:r,Al:o,Bh:s,Bl:a,Ch:u,Cl:i,Dh:D,Dl:c,Eh:l,El:p,Fh:w,Fl:h,Gh:g,Gl:S,Hh:v,Hl:L}=this;for(let d=0;d<80;d++){const m=x.rotrSH(l,p,14)^x.rotrSH(l,p,18)^x.rotrBH(l,p,41),F=x.rotrSL(l,p,14)^x.rotrSL(l,p,18)^x.rotrBL(l,p,41),q=l&w^~l&g,z=p&h^~p&S,I=x.add5L(L,F,z,Yn[d],Q[d]),O=x.add5H(I,v,m,q,Vn[d],P[d]),ot=I|0,tt=x.rotrSH(r,o,28)^x.rotrBH(r,o,34)^x.rotrBH(r,o,39),st=x.rotrSL(r,o,28)^x.rotrBL(r,o,34)^x.rotrBL(r,o,39),at=r&s^r&u^s&u,Ct=o&a^o&i^a&i;v=g|0,L=S|0,g=w|0,S=h|0,w=l|0,h=p|0,{h:l,l:p}=x.add(D|0,c|0,O|0,ot|0),D=u|0,c=i|0,u=s|0,i=a|0,s=r|0,a=o|0;const At=x.add3L(ot,st,Ct);r=x.add3H(At,O,tt,at),o=At|0}({h:r,l:o}=x.add(this.Ah|0,this.Al|0,r|0,o|0)),{h:s,l:a}=x.add(this.Bh|0,this.Bl|0,s|0,a|0),{h:u,l:i}=x.add(this.Ch|0,this.Cl|0,u|0,i|0),{h:D,l:c}=x.add(this.Dh|0,this.Dl|0,D|0,c|0),{h:l,l:p}=x.add(this.Eh|0,this.El|0,l|0,p|0),{h:w,l:h}=x.add(this.Fh|0,this.Fl|0,w|0,h|0),{h:g,l:S}=x.add(this.Gh|0,this.Gl|0,g|0,S|0),{h:v,l:L}=x.add(this.Hh|0,this.Hl|0,v|0,L|0),this.set(r,o,s,a,u,i,D,c,l,p,w,h,g,S,v,L)}roundClean(){P.fill(0),Q.fill(0)}destroy(){this.buffer.fill(0),this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)}}const Kn=Bn(()=>new Jn);/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */const vt=BigInt(0),be=BigInt(1),Wn=BigInt(2);function It(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Ut(t){if(!It(t))throw new Error("Uint8Array expected")}function Tt(t,e){if(typeof e!="boolean")throw new Error(t+" boolean expected, got "+e)}const Xn=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function Ft(t){Ut(t);let e="";for(let n=0;n<t.length;n++)e+=Xn[t[n]];return e}function pe(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?vt:BigInt("0x"+t)}const K={_0:48,_9:57,A:65,F:70,a:97,f:102};function we(t){if(t>=K._0&&t<=K._9)return t-K._0;if(t>=K.A&&t<=K.F)return t-(K.A-10);if(t>=K.a&&t<=K.f)return t-(K.a-10)}function Ee(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);const e=t.length,n=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);const r=new Uint8Array(n);for(let o=0,s=0;o<n;o++,s+=2){const a=we(t.charCodeAt(s)),u=we(t.charCodeAt(s+1));if(a===void 0||u===void 0){const i=t[s]+t[s+1];throw new Error('hex string expected, got non-hex character "'+i+'" at index '+s)}r[o]=a*16+u}return r}function Pn(t){return pe(Ft(t))}function Et(t){return Ut(t),pe(Ft(Uint8Array.from(t).reverse()))}function ge(t,e){return Ee(t.toString(16).padStart(e*2,"0"))}function Nt(t,e){return ge(t,e).reverse()}function W(t,e,n){let r;if(typeof e=="string")try{r=Ee(e)}catch(s){throw new Error(t+" must be hex string or Uint8Array, cause: "+s)}else if(It(e))r=Uint8Array.from(e);else throw new Error(t+" must be hex string or Uint8Array");const o=r.length;if(typeof n=="number"&&o!==n)throw new Error(t+" of length "+n+" expected, got "+o);return r}function ye(...t){let e=0;for(let r=0;r<t.length;r++){const o=t[r];Ut(o),e+=o.length}const n=new Uint8Array(e);for(let r=0,o=0;r<t.length;r++){const s=t[r];n.set(s,o),o+=s.length}return n}const Lt=t=>typeof t=="bigint"&&vt<=t;function Qn(t,e,n){return Lt(t)&&Lt(e)&&Lt(n)&&e<=t&&t<n}function ft(t,e,n,r){if(!Qn(e,n,r))throw new Error("expected valid "+t+": "+n+" <= n < "+r+", got "+e)}function tr(t){let e;for(e=0;t>vt;t>>=be,e+=1);return e}const er=t=>(Wn<<BigInt(t-1))-be,nr={bigint:t=>typeof t=="bigint",function:t=>typeof t=="function",boolean:t=>typeof t=="boolean",string:t=>typeof t=="string",stringOrUint8Array:t=>typeof t=="string"||It(t),isSafeInteger:t=>Number.isSafeInteger(t),array:t=>Array.isArray(t),field:(t,e)=>e.Fp.isValid(t),hash:t=>typeof t=="function"&&Number.isSafeInteger(t.outputLen)};function Ot(t,e,n={}){const r=(o,s,a)=>{const u=nr[s];if(typeof u!="function")throw new Error("invalid validator function");const i=t[o];if(!(a&&i===void 0)&&!u(i,t))throw new Error("param "+String(o)+" is invalid. Expected "+s+", got "+i)};for(const[o,s]of Object.entries(e))r(o,s,!1);for(const[o,s]of Object.entries(n))r(o,s,!0);return t}function xe(t){const e=new WeakMap;return(n,...r)=>{const o=e.get(n);if(o!==void 0)return o;const s=t(n,...r);return e.set(n,s),s}}const M=BigInt(0),N=BigInt(1),nt=BigInt(2),rr=BigInt(3),Ht=BigInt(4),Be=BigInt(5),index_es_Ce=BigInt(8);function H(t,e){const n=t%e;return n>=M?n:e+n}function or(t,e,n){if(e<M)throw new Error("invalid exponent, negatives unsupported");if(n<=M)throw new Error("invalid modulus");if(n===N)return M;let r=N;for(;e>M;)e&N&&(r=r*t%n),t=t*t%n,e>>=N;return r}function J(t,e,n){let r=t;for(;e-- >M;)r*=r,r%=n;return r}function Ae(t,e){if(t===M)throw new Error("invert: expected non-zero number");if(e<=M)throw new Error("invert: expected positive modulus, got "+e);let n=H(t,e),r=e,o=M,s=N;for(;n!==M;){const u=r/n,i=r%n,D=o-s*u;r=n,n=i,o=s,s=D}if(r!==N)throw new Error("invert: does not exist");return H(o,e)}function sr(t){const e=(t-N)/nt;let n,r,o;for(n=t-N,r=0;n%nt===M;n/=nt,r++);for(o=nt;o<t&&or(o,e,t)!==t-N;o++)if(o>1e3)throw new Error("Cannot find square root: likely non-prime P");if(r===1){const a=(t+N)/Ht;return function(i,D){const c=i.pow(D,a);if(!i.eql(i.sqr(c),D))throw new Error("Cannot find square root");return c}}const s=(n+N)/nt;return function(u,i){if(u.pow(i,e)===u.neg(u.ONE))throw new Error("Cannot find square root");let D=r,c=u.pow(u.mul(u.ONE,o),n),l=u.pow(i,s),p=u.pow(i,n);for(;!u.eql(p,u.ONE);){if(u.eql(p,u.ZERO))return u.ZERO;let w=1;for(let g=u.sqr(p);w<D&&!u.eql(g,u.ONE);w++)g=u.sqr(g);const h=u.pow(c,N<<BigInt(D-w-1));c=u.sqr(h),l=u.mul(l,h),p=u.mul(p,c),D=w}return l}}function ir(t){if(t%Ht===rr){const e=(t+N)/Ht;return function(r,o){const s=r.pow(o,e);if(!r.eql(r.sqr(s),o))throw new Error("Cannot find square root");return s}}if(t%index_es_Ce===Be){const e=(t-Be)/index_es_Ce;return function(r,o){const s=r.mul(o,nt),a=r.pow(s,e),u=r.mul(o,a),i=r.mul(r.mul(u,nt),a),D=r.mul(u,r.sub(i,r.ONE));if(!r.eql(r.sqr(D),o))throw new Error("Cannot find square root");return D}}return sr(t)}const ur=(t,e)=>(H(t,e)&N)===N,cr=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function ar(t){const e={ORDER:"bigint",MASK:"bigint",BYTES:"isSafeInteger",BITS:"isSafeInteger"},n=cr.reduce((r,o)=>(r[o]="function",r),e);return Ot(t,n)}function fr(t,e,n){if(n<M)throw new Error("invalid exponent, negatives unsupported");if(n===M)return t.ONE;if(n===N)return e;let r=t.ONE,o=e;for(;n>M;)n&N&&(r=t.mul(r,o)),o=t.sqr(o),n>>=N;return r}function Dr(t,e){const n=new Array(e.length),r=e.reduce((s,a,u)=>t.is0(a)?s:(n[u]=s,t.mul(s,a)),t.ONE),o=t.inv(r);return e.reduceRight((s,a,u)=>t.is0(a)?s:(n[u]=t.mul(s,n[u]),t.mul(s,a)),o),n}function me(t,e){const n=e!==void 0?e:t.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}function _e(t,e,n=!1,r={}){if(t<=M)throw new Error("invalid field: expected ORDER > 0, got "+t);const{nBitLength:o,nByteLength:s}=me(t,e);if(s>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");let a;const u=Object.freeze({ORDER:t,isLE:n,BITS:o,BYTES:s,MASK:er(o),ZERO:M,ONE:N,create:i=>H(i,t),isValid:i=>{if(typeof i!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof i);return M<=i&&i<t},is0:i=>i===M,isOdd:i=>(i&N)===N,neg:i=>H(-i,t),eql:(i,D)=>i===D,sqr:i=>H(i*i,t),add:(i,D)=>H(i+D,t),sub:(i,D)=>H(i-D,t),mul:(i,D)=>H(i*D,t),pow:(i,D)=>fr(u,i,D),div:(i,D)=>H(i*Ae(D,t),t),sqrN:i=>i*i,addN:(i,D)=>i+D,subN:(i,D)=>i-D,mulN:(i,D)=>i*D,inv:i=>Ae(i,t),sqrt:r.sqrt||(i=>(a||(a=ir(t)),a(u,i))),invertBatch:i=>Dr(u,i),cmov:(i,D,c)=>c?D:i,toBytes:i=>n?Nt(i,s):ge(i,s),fromBytes:i=>{if(i.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+i.length);return n?Et(i):Pn(i)}});return Object.freeze(u)}const Se=BigInt(0),gt=BigInt(1);function zt(t,e){const n=e.negate();return t?n:e}function ve(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function Mt(t,e){ve(t,e);const n=Math.ceil(e/t)+1,r=2**(t-1);return{windows:n,windowSize:r}}function dr(t,e){if(!Array.isArray(t))throw new Error("array expected");t.forEach((n,r)=>{if(!(n instanceof e))throw new Error("invalid point at index "+r)})}function hr(t,e){if(!Array.isArray(t))throw new Error("array of scalars expected");t.forEach((n,r)=>{if(!e.isValid(n))throw new Error("invalid scalar at index "+r)})}const qt=new WeakMap,Ie=new WeakMap;function $t(t){return Ie.get(t)||1}function lr(t,e){return{constTimeNegate:zt,hasPrecomputes(n){return $t(n)!==1},unsafeLadder(n,r,o=t.ZERO){let s=n;for(;r>Se;)r&gt&&(o=o.add(s)),s=s.double(),r>>=gt;return o},precomputeWindow(n,r){const{windows:o,windowSize:s}=Mt(r,e),a=[];let u=n,i=u;for(let D=0;D<o;D++){i=u,a.push(i);for(let c=1;c<s;c++)i=i.add(u),a.push(i);u=i.double()}return a},wNAF(n,r,o){const{windows:s,windowSize:a}=Mt(n,e);let u=t.ZERO,i=t.BASE;const D=BigInt(2**n-1),c=2**n,l=BigInt(n);for(let p=0;p<s;p++){const w=p*a;let h=Number(o&D);o>>=l,h>a&&(h-=c,o+=gt);const g=w,S=w+Math.abs(h)-1,v=p%2!==0,L=h<0;h===0?i=i.add(zt(v,r[g])):u=u.add(zt(L,r[S]))}return{p:u,f:i}},wNAFUnsafe(n,r,o,s=t.ZERO){const{windows:a,windowSize:u}=Mt(n,e),i=BigInt(2**n-1),D=2**n,c=BigInt(n);for(let l=0;l<a;l++){const p=l*u;if(o===Se)break;let w=Number(o&i);if(o>>=c,w>u&&(w-=D,o+=gt),w===0)continue;let h=r[p+Math.abs(w)-1];w<0&&(h=h.negate()),s=s.add(h)}return s},getPrecomputes(n,r,o){let s=qt.get(r);return s||(s=this.precomputeWindow(r,n),n!==1&&qt.set(r,o(s))),s},wNAFCached(n,r,o){const s=$t(n);return this.wNAF(s,this.getPrecomputes(s,n,o),r)},wNAFCachedUnsafe(n,r,o,s){const a=$t(n);return a===1?this.unsafeLadder(n,r,s):this.wNAFUnsafe(a,this.getPrecomputes(a,n,o),r,s)},setWindowSize(n,r){ve(r,e),Ie.set(n,r),qt.delete(n)}}}function br(t,e,n,r){if(dr(n,t),hr(r,e),n.length!==r.length)throw new Error("arrays of points and scalars must have equal length");const o=t.ZERO,s=tr(BigInt(n.length)),a=s>12?s-3:s>4?s-2:s?2:1,u=(1<<a)-1,i=new Array(u+1).fill(o),D=Math.floor((e.BITS-1)/a)*a;let c=o;for(let l=D;l>=0;l-=a){i.fill(o);for(let w=0;w<r.length;w++){const h=r[w],g=Number(h>>BigInt(l)&BigInt(u));i[g]=i[g].add(n[w])}let p=o;for(let w=i.length-1,h=o;w>0;w--)h=h.add(i[w]),p=p.add(h);if(c=c.add(p),l!==0)for(let w=0;w<a;w++)c=c.double()}return c}function pr(t){return ar(t.Fp),Ot(t,{n:"bigint",h:"bigint",Gx:"field",Gy:"field"},{nBitLength:"isSafeInteger",nByteLength:"isSafeInteger"}),Object.freeze({...me(t.n,t.nBitLength),...t,p:t.Fp.ORDER})}const G=BigInt(0),j=BigInt(1),yt=BigInt(2),wr=BigInt(8),Er={zip215:!0};function gr(t){const e=pr(t);return Ot(t,{hash:"function",a:"bigint",d:"bigint",randomBytes:"function"},{adjustScalarBytes:"function",domain:"function",uvRatio:"function",mapToCurve:"function"}),Object.freeze({...e})}function yr(t){const e=gr(t),{Fp:n,n:r,prehash:o,hash:s,randomBytes:a,nByteLength:u,h:i}=e,D=yt<<BigInt(u*8)-j,c=n.create,l=_e(e.n,e.nBitLength),p=e.uvRatio||((y,f)=>{try{return{isValid:!0,value:n.sqrt(y*n.inv(f))}}catch{return{isValid:!1,value:G}}}),w=e.adjustScalarBytes||(y=>y),h=e.domain||((y,f,b)=>{if(Tt("phflag",b),f.length||b)throw new Error("Contexts/pre-hash are not supported");return y});function g(y,f){ft("coordinate "+y,f,G,D)}function S(y){if(!(y instanceof d))throw new Error("ExtendedPoint expected")}const v=xe((y,f)=>{const{ex:b,ey:E,ez:B}=y,C=y.is0();f==null&&(f=C?wr:n.inv(B));const A=c(b*f),U=c(E*f),_=c(B*f);if(C)return{x:G,y:j};if(_!==j)throw new Error("invZ was invalid");return{x:A,y:U}}),L=xe(y=>{const{a:f,d:b}=e;if(y.is0())throw new Error("bad point: ZERO");const{ex:E,ey:B,ez:C,et:A}=y,U=c(E*E),_=c(B*B),T=c(C*C),$=c(T*T),R=c(U*f),V=c(T*c(R+_)),Y=c($+c(b*c(U*_)));if(V!==Y)throw new Error("bad point: equation left != right (1)");const Z=c(E*B),X=c(C*A);if(Z!==X)throw new Error("bad point: equation left != right (2)");return!0});class d{constructor(f,b,E,B){this.ex=f,this.ey=b,this.ez=E,this.et=B,g("x",f),g("y",b),g("z",E),g("t",B),Object.freeze(this)}get x(){return this.toAffine().x}get y(){return this.toAffine().y}static fromAffine(f){if(f instanceof d)throw new Error("extended point not allowed");const{x:b,y:E}=f||{};return g("x",b),g("y",E),new d(b,E,j,c(b*E))}static normalizeZ(f){const b=n.invertBatch(f.map(E=>E.ez));return f.map((E,B)=>E.toAffine(b[B])).map(d.fromAffine)}static msm(f,b){return br(d,l,f,b)}_setWindowSize(f){q.setWindowSize(this,f)}assertValidity(){L(this)}equals(f){S(f);const{ex:b,ey:E,ez:B}=this,{ex:C,ey:A,ez:U}=f,_=c(b*U),T=c(C*B),$=c(E*U),R=c(A*B);return _===T&&$===R}is0(){return this.equals(d.ZERO)}negate(){return new d(c(-this.ex),this.ey,this.ez,c(-this.et))}double(){const{a:f}=e,{ex:b,ey:E,ez:B}=this,C=c(b*b),A=c(E*E),U=c(yt*c(B*B)),_=c(f*C),T=b+E,$=c(c(T*T)-C-A),R=_+A,V=R-U,Y=_-A,Z=c($*V),X=c(R*Y),et=c($*Y),pt=c(V*R);return new d(Z,X,pt,et)}add(f){S(f);const{a:b,d:E}=e,{ex:B,ey:C,ez:A,et:U}=this,{ex:_,ey:T,ez:$,et:R}=f;if(b===BigInt(-1)){const re=c((C-B)*(T+_)),oe=c((C+B)*(T-_)),mt=c(oe-re);if(mt===G)return this.double();const se=c(A*yt*R),ie=c(U*yt*$),ue=ie+se,ce=oe+re,ae=ie-se,Dn=c(ue*mt),dn=c(ce*ae),hn=c(ue*ae),ln=c(mt*ce);return new d(Dn,dn,ln,hn)}const V=c(B*_),Y=c(C*T),Z=c(U*E*R),X=c(A*$),et=c((B+C)*(_+T)-V-Y),pt=X-Z,ee=X+Z,ne=c(Y-b*V),un=c(et*pt),cn=c(ee*ne),an=c(et*ne),fn=c(pt*ee);return new d(un,cn,fn,an)}subtract(f){return this.add(f.negate())}wNAF(f){return q.wNAFCached(this,f,d.normalizeZ)}multiply(f){const b=f;ft("scalar",b,j,r);const{p:E,f:B}=this.wNAF(b);return d.normalizeZ([E,B])[0]}multiplyUnsafe(f,b=d.ZERO){const E=f;return ft("scalar",E,G,r),E===G?F:this.is0()||E===j?this:q.wNAFCachedUnsafe(this,E,d.normalizeZ,b)}isSmallOrder(){return this.multiplyUnsafe(i).is0()}isTorsionFree(){return q.unsafeLadder(this,r).is0()}toAffine(f){return v(this,f)}clearCofactor(){const{h:f}=e;return f===j?this:this.multiplyUnsafe(f)}static fromHex(f,b=!1){const{d:E,a:B}=e,C=n.BYTES;f=W("pointHex",f,C),Tt("zip215",b);const A=f.slice(),U=f[C-1];A[C-1]=U&-129;const _=Et(A),T=b?D:n.ORDER;ft("pointHex.y",_,G,T);const $=c(_*_),R=c($-j),V=c(E*$-B);let{isValid:Y,value:Z}=p(R,V);if(!Y)throw new Error("Point.fromHex: invalid y coordinate");const X=(Z&j)===j,et=(U&128)!==0;if(!b&&Z===G&&et)throw new Error("Point.fromHex: x=0 and x_0=1");return et!==X&&(Z=c(-Z)),d.fromAffine({x:Z,y:_})}static fromPrivateKey(f){return O(f).point}toRawBytes(){const{x:f,y:b}=this.toAffine(),E=Nt(b,n.BYTES);return E[E.length-1]|=f&j?128:0,E}toHex(){return Ft(this.toRawBytes())}}d.BASE=new d(e.Gx,e.Gy,j,c(e.Gx*e.Gy)),d.ZERO=new d(G,j,j,G);const{BASE:m,ZERO:F}=d,q=lr(d,u*8);function z(y){return H(y,r)}function I(y){return z(Et(y))}function O(y){const f=n.BYTES;y=W("private key",y,f);const b=W("hashed private key",s(y),2*f),E=w(b.slice(0,f)),B=b.slice(f,2*f),C=I(E),A=m.multiply(C),U=A.toRawBytes();return{head:E,prefix:B,scalar:C,point:A,pointBytes:U}}function ot(y){return O(y).pointBytes}function tt(y=new Uint8Array,...f){const b=ye(...f);return I(s(h(b,W("context",y),!!o)))}function st(y,f,b={}){y=W("message",y),o&&(y=o(y));const{prefix:E,scalar:B,pointBytes:C}=O(f),A=tt(b.context,E,y),U=m.multiply(A).toRawBytes(),_=tt(b.context,U,C,y),T=z(A+_*B);ft("signature.s",T,G,r);const $=ye(U,Nt(T,n.BYTES));return W("result",$,n.BYTES*2)}const at=Er;function Ct(y,f,b,E=at){const{context:B,zip215:C}=E,A=n.BYTES;y=W("signature",y,2*A),f=W("message",f),b=W("publicKey",b,A),C!==void 0&&Tt("zip215",C),o&&(f=o(f));const U=Et(y.slice(A,2*A));let _,T,$;try{_=d.fromHex(b,C),T=d.fromHex(y.slice(0,A),C),$=m.multiplyUnsafe(U)}catch{return!1}if(!C&&_.isSmallOrder())return!1;const R=tt(B,T.toRawBytes(),_.toRawBytes(),f);return T.add(_.multiplyUnsafe(R)).subtract($).clearCofactor().equals(d.ZERO)}return m._setWindowSize(8),{CURVE:e,getPublicKey:ot,sign:st,verify:Ct,ExtendedPoint:d,utils:{getExtendedPublicKey:O,randomPrivateKey:()=>a(n.BYTES),precompute(y=8,f=d.BASE){return f._setWindowSize(y),f.multiply(BigInt(3)),f}}}}BigInt(0),BigInt(1);const index_es_kt=BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949"),Ue=BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");BigInt(0);const xr=BigInt(1),Te=BigInt(2);BigInt(3);const Br=BigInt(5),Cr=BigInt(8);function Ar(t){const e=BigInt(10),n=BigInt(20),r=BigInt(40),o=BigInt(80),s=index_es_kt,u=t*t%s*t%s,i=J(u,Te,s)*u%s,D=J(i,xr,s)*t%s,c=J(D,Br,s)*D%s,l=J(c,e,s)*c%s,p=J(l,n,s)*l%s,w=J(p,r,s)*p%s,h=J(w,o,s)*w%s,g=J(h,o,s)*w%s,S=J(g,e,s)*c%s;return{pow_p_5_8:J(S,Te,s)*t%s,b2:u}}function mr(t){return t[0]&=248,t[31]&=127,t[31]|=64,t}function _r(t,e){const n=index_es_kt,r=H(e*e*e,n),o=H(r*r*e,n),s=Ar(t*o).pow_p_5_8;let a=H(t*r*s,n);const u=H(e*a*a,n),i=a,D=H(a*Ue,n),c=u===t,l=u===H(-t,n),p=u===H(-t*Ue,n);return c&&(a=i),(l||p)&&(a=D),ur(a,n)&&(a=H(-a,n)),{isValid:c||l,value:a}}const Sr=(()=>_e(index_es_kt,void 0,!0))(),vr=(()=>({a:BigInt(-1),d:BigInt("37095705934669439343138083508754565189542113879843219016388785533085940283555"),Fp:Sr,n:BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989"),h:Cr,Gx:BigInt("15112221349535400772501151409588531511454012693041857206046113283949847762202"),Gy:BigInt("46316835694926478169428394003475163141307993866256225615783033603165251855960"),hash:Kn,randomBytes:he,adjustScalarBytes:mr,uvRatio:_r}))(),Rt=(()=>yr(vr))(),jt="EdDSA",Zt="JWT",ut=".",Dt="base64url",Gt="utf8",xt="utf8",Vt=":",Yt="did",Jt="key",dt="base58btc",Kt="z",Wt="K36",Fe=32,Ne=32;function Xt(t){return globalThis.Buffer!=null?new Uint8Array(t.buffer,t.byteOffset,t.byteLength):t}function Le(t=0){return globalThis.Buffer!=null&&globalThis.Buffer.allocUnsafe!=null?Xt(globalThis.Buffer.allocUnsafe(t)):new Uint8Array(t)}function Oe(t,e){e||(e=t.reduce((o,s)=>o+s.length,0));const n=Le(e);let r=0;for(const o of t)n.set(o,r),r+=o.length;return Xt(n)}function Ir(t,e){if(t.length>=255)throw new TypeError("Alphabet too long");for(var n=new Uint8Array(256),r=0;r<n.length;r++)n[r]=255;for(var o=0;o<t.length;o++){var s=t.charAt(o),a=s.charCodeAt(0);if(n[a]!==255)throw new TypeError(s+" is ambiguous");n[a]=o}var u=t.length,i=t.charAt(0),D=Math.log(u)/Math.log(256),c=Math.log(256)/Math.log(u);function l(h){if(h instanceof Uint8Array||(ArrayBuffer.isView(h)?h=new Uint8Array(h.buffer,h.byteOffset,h.byteLength):Array.isArray(h)&&(h=Uint8Array.from(h))),!(h instanceof Uint8Array))throw new TypeError("Expected Uint8Array");if(h.length===0)return"";for(var g=0,S=0,v=0,L=h.length;v!==L&&h[v]===0;)v++,g++;for(var d=(L-v)*c+1>>>0,m=new Uint8Array(d);v!==L;){for(var F=h[v],q=0,z=d-1;(F!==0||q<S)&&z!==-1;z--,q++)F+=256*m[z]>>>0,m[z]=F%u>>>0,F=F/u>>>0;if(F!==0)throw new Error("Non-zero carry");S=q,v++}for(var I=d-S;I!==d&&m[I]===0;)I++;for(var O=i.repeat(g);I<d;++I)O+=t.charAt(m[I]);return O}function p(h){if(typeof h!="string")throw new TypeError("Expected String");if(h.length===0)return new Uint8Array;var g=0;if(h[g]!==" "){for(var S=0,v=0;h[g]===i;)S++,g++;for(var L=(h.length-g)*D+1>>>0,d=new Uint8Array(L);h[g];){var m=n[h.charCodeAt(g)];if(m===255)return;for(var F=0,q=L-1;(m!==0||F<v)&&q!==-1;q--,F++)m+=u*d[q]>>>0,d[q]=m%256>>>0,m=m/256>>>0;if(m!==0)throw new Error("Non-zero carry");v=F,g++}if(h[g]!==" "){for(var z=L-v;z!==L&&d[z]===0;)z++;for(var I=new Uint8Array(S+(L-z)),O=S;z!==L;)I[O++]=d[z++];return I}}}function w(h){var g=p(h);if(g)return g;throw new Error(`Non-${e} character`)}return{encode:l,decodeUnsafe:p,decode:w}}var Ur=Ir,Tr=Ur;const He=t=>{if(t instanceof Uint8Array&&t.constructor.name==="Uint8Array")return t;if(t instanceof ArrayBuffer)return new Uint8Array(t);if(ArrayBuffer.isView(t))return new Uint8Array(t.buffer,t.byteOffset,t.byteLength);throw new Error("Unknown type, must be binary type")},Fr=t=>new TextEncoder().encode(t),Nr=t=>new TextDecoder().decode(t);class Lr{constructor(e,n,r){this.name=e,this.prefix=n,this.baseEncode=r}encode(e){if(e instanceof Uint8Array)return`${this.prefix}${this.baseEncode(e)}`;throw Error("Unknown type, must be binary type")}}class Or{constructor(e,n,r){if(this.name=e,this.prefix=n,n.codePointAt(0)===void 0)throw new Error("Invalid prefix character");this.prefixCodePoint=n.codePointAt(0),this.baseDecode=r}decode(e){if(typeof e=="string"){if(e.codePointAt(0)!==this.prefixCodePoint)throw Error(`Unable to decode multibase string ${JSON.stringify(e)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);return this.baseDecode(e.slice(this.prefix.length))}else throw Error("Can only multibase decode strings")}or(e){return ze(this,e)}}class Hr{constructor(e){this.decoders=e}or(e){return ze(this,e)}decode(e){const n=e[0],r=this.decoders[n];if(r)return r.decode(e);throw RangeError(`Unable to decode multibase string ${JSON.stringify(e)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`)}}const ze=(t,e)=>new Hr({...t.decoders||{[t.prefix]:t},...e.decoders||{[e.prefix]:e}});class zr{constructor(e,n,r,o){this.name=e,this.prefix=n,this.baseEncode=r,this.baseDecode=o,this.encoder=new Lr(e,n,r),this.decoder=new Or(e,n,o)}encode(e){return this.encoder.encode(e)}decode(e){return this.decoder.decode(e)}}const Bt=({name:t,prefix:e,encode:n,decode:r})=>new zr(t,e,n,r),ht=({prefix:t,name:e,alphabet:n})=>{const{encode:r,decode:o}=Tr(n,e);return Bt({prefix:t,name:e,encode:r,decode:s=>He(o(s))})},Mr=(t,e,n,r)=>{const o={};for(let c=0;c<e.length;++c)o[e[c]]=c;let s=t.length;for(;t[s-1]==="=";)--s;const a=new Uint8Array(s*n/8|0);let u=0,i=0,D=0;for(let c=0;c<s;++c){const l=o[t[c]];if(l===void 0)throw new SyntaxError(`Non-${r} character`);i=i<<n|l,u+=n,u>=8&&(u-=8,a[D++]=255&i>>u)}if(u>=n||255&i<<8-u)throw new SyntaxError("Unexpected end of data");return a},qr=(t,e,n)=>{const r=e[e.length-1]==="=",o=(1<<n)-1;let s="",a=0,u=0;for(let i=0;i<t.length;++i)for(u=u<<8|t[i],a+=8;a>n;)a-=n,s+=e[o&u>>a];if(a&&(s+=e[o&u<<n-a]),r)for(;s.length*n&7;)s+="=";return s},k=({name:t,prefix:e,bitsPerChar:n,alphabet:r})=>Bt({prefix:e,name:t,encode(o){return qr(o,r,n)},decode(o){return Mr(o,r,n,t)}}),$r=Bt({prefix:"\0",name:"identity",encode:t=>Nr(t),decode:t=>Fr(t)});var kr=Object.freeze({__proto__:null,identity:$r});const Rr=k({prefix:"0",name:"base2",alphabet:"01",bitsPerChar:1});var jr=Object.freeze({__proto__:null,base2:Rr});const Zr=k({prefix:"7",name:"base8",alphabet:"01234567",bitsPerChar:3});var Gr=Object.freeze({__proto__:null,base8:Zr});const Vr=ht({prefix:"9",name:"base10",alphabet:"0123456789"});var Yr=Object.freeze({__proto__:null,base10:Vr});const Jr=k({prefix:"f",name:"base16",alphabet:"0123456789abcdef",bitsPerChar:4}),Kr=k({prefix:"F",name:"base16upper",alphabet:"0123456789ABCDEF",bitsPerChar:4});var Wr=Object.freeze({__proto__:null,base16:Jr,base16upper:Kr});const Xr=k({prefix:"b",name:"base32",alphabet:"abcdefghijklmnopqrstuvwxyz234567",bitsPerChar:5}),Pr=k({prefix:"B",name:"base32upper",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",bitsPerChar:5}),Qr=k({prefix:"c",name:"base32pad",alphabet:"abcdefghijklmnopqrstuvwxyz234567=",bitsPerChar:5}),to=k({prefix:"C",name:"base32padupper",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",bitsPerChar:5}),eo=k({prefix:"v",name:"base32hex",alphabet:"0123456789abcdefghijklmnopqrstuv",bitsPerChar:5}),no=k({prefix:"V",name:"base32hexupper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUV",bitsPerChar:5}),ro=k({prefix:"t",name:"base32hexpad",alphabet:"0123456789abcdefghijklmnopqrstuv=",bitsPerChar:5}),oo=k({prefix:"T",name:"base32hexpadupper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUV=",bitsPerChar:5}),so=k({prefix:"h",name:"base32z",alphabet:"ybndrfg8ejkmcpqxot1uwisza345h769",bitsPerChar:5});var io=Object.freeze({__proto__:null,base32:Xr,base32upper:Pr,base32pad:Qr,base32padupper:to,base32hex:eo,base32hexupper:no,base32hexpad:ro,base32hexpadupper:oo,base32z:so});const uo=ht({prefix:"k",name:"base36",alphabet:"0123456789abcdefghijklmnopqrstuvwxyz"}),co=ht({prefix:"K",name:"base36upper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"});var ao=Object.freeze({__proto__:null,base36:uo,base36upper:co});const fo=ht({name:"base58btc",prefix:"z",alphabet:"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"}),Do=ht({name:"base58flickr",prefix:"Z",alphabet:"123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"});var ho=Object.freeze({__proto__:null,base58btc:fo,base58flickr:Do});const lo=k({prefix:"m",name:"base64",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",bitsPerChar:6}),bo=k({prefix:"M",name:"base64pad",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",bitsPerChar:6}),po=k({prefix:"u",name:"base64url",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",bitsPerChar:6}),wo=k({prefix:"U",name:"base64urlpad",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=",bitsPerChar:6});var Eo=Object.freeze({__proto__:null,base64:lo,base64pad:bo,base64url:po,base64urlpad:wo});const Me=Array.from("\u{1F680}\u{1FA90}\u2604\u{1F6F0}\u{1F30C}\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}\u{1F30D}\u{1F30F}\u{1F30E}\u{1F409}\u2600\u{1F4BB}\u{1F5A5}\u{1F4BE}\u{1F4BF}\u{1F602}\u2764\u{1F60D}\u{1F923}\u{1F60A}\u{1F64F}\u{1F495}\u{1F62D}\u{1F618}\u{1F44D}\u{1F605}\u{1F44F}\u{1F601}\u{1F525}\u{1F970}\u{1F494}\u{1F496}\u{1F499}\u{1F622}\u{1F914}\u{1F606}\u{1F644}\u{1F4AA}\u{1F609}\u263A\u{1F44C}\u{1F917}\u{1F49C}\u{1F614}\u{1F60E}\u{1F607}\u{1F339}\u{1F926}\u{1F389}\u{1F49E}\u270C\u2728\u{1F937}\u{1F631}\u{1F60C}\u{1F338}\u{1F64C}\u{1F60B}\u{1F497}\u{1F49A}\u{1F60F}\u{1F49B}\u{1F642}\u{1F493}\u{1F929}\u{1F604}\u{1F600}\u{1F5A4}\u{1F603}\u{1F4AF}\u{1F648}\u{1F447}\u{1F3B6}\u{1F612}\u{1F92D}\u2763\u{1F61C}\u{1F48B}\u{1F440}\u{1F62A}\u{1F611}\u{1F4A5}\u{1F64B}\u{1F61E}\u{1F629}\u{1F621}\u{1F92A}\u{1F44A}\u{1F973}\u{1F625}\u{1F924}\u{1F449}\u{1F483}\u{1F633}\u270B\u{1F61A}\u{1F61D}\u{1F634}\u{1F31F}\u{1F62C}\u{1F643}\u{1F340}\u{1F337}\u{1F63B}\u{1F613}\u2B50\u2705\u{1F97A}\u{1F308}\u{1F608}\u{1F918}\u{1F4A6}\u2714\u{1F623}\u{1F3C3}\u{1F490}\u2639\u{1F38A}\u{1F498}\u{1F620}\u261D\u{1F615}\u{1F33A}\u{1F382}\u{1F33B}\u{1F610}\u{1F595}\u{1F49D}\u{1F64A}\u{1F639}\u{1F5E3}\u{1F4AB}\u{1F480}\u{1F451}\u{1F3B5}\u{1F91E}\u{1F61B}\u{1F534}\u{1F624}\u{1F33C}\u{1F62B}\u26BD\u{1F919}\u2615\u{1F3C6}\u{1F92B}\u{1F448}\u{1F62E}\u{1F646}\u{1F37B}\u{1F343}\u{1F436}\u{1F481}\u{1F632}\u{1F33F}\u{1F9E1}\u{1F381}\u26A1\u{1F31E}\u{1F388}\u274C\u270A\u{1F44B}\u{1F630}\u{1F928}\u{1F636}\u{1F91D}\u{1F6B6}\u{1F4B0}\u{1F353}\u{1F4A2}\u{1F91F}\u{1F641}\u{1F6A8}\u{1F4A8}\u{1F92C}\u2708\u{1F380}\u{1F37A}\u{1F913}\u{1F619}\u{1F49F}\u{1F331}\u{1F616}\u{1F476}\u{1F974}\u25B6\u27A1\u2753\u{1F48E}\u{1F4B8}\u2B07\u{1F628}\u{1F31A}\u{1F98B}\u{1F637}\u{1F57A}\u26A0\u{1F645}\u{1F61F}\u{1F635}\u{1F44E}\u{1F932}\u{1F920}\u{1F927}\u{1F4CC}\u{1F535}\u{1F485}\u{1F9D0}\u{1F43E}\u{1F352}\u{1F617}\u{1F911}\u{1F30A}\u{1F92F}\u{1F437}\u260E\u{1F4A7}\u{1F62F}\u{1F486}\u{1F446}\u{1F3A4}\u{1F647}\u{1F351}\u2744\u{1F334}\u{1F4A3}\u{1F438}\u{1F48C}\u{1F4CD}\u{1F940}\u{1F922}\u{1F445}\u{1F4A1}\u{1F4A9}\u{1F450}\u{1F4F8}\u{1F47B}\u{1F910}\u{1F92E}\u{1F3BC}\u{1F975}\u{1F6A9}\u{1F34E}\u{1F34A}\u{1F47C}\u{1F48D}\u{1F4E3}\u{1F942}"),go=Me.reduce((t,e,n)=>(t[n]=e,t),[]),yo=Me.reduce((t,e,n)=>(t[e.codePointAt(0)]=n,t),[]);function xo(t){return t.reduce((e,n)=>(e+=go[n],e),"")}function Bo(t){const e=[];for(const n of t){const r=yo[n.codePointAt(0)];if(r===void 0)throw new Error(`Non-base256emoji character: ${n}`);e.push(r)}return new Uint8Array(e)}const Co=Bt({prefix:"\u{1F680}",name:"base256emoji",encode:xo,decode:Bo});var Ao=Object.freeze({__proto__:null,base256emoji:Co}),mo=$e,qe=128,_o=127,So=~_o,vo=Math.pow(2,31);function $e(t,e,n){e=e||[],n=n||0;for(var r=n;t>=vo;)e[n++]=t&255|qe,t/=128;for(;t&So;)e[n++]=t&255|qe,t>>>=7;return e[n]=t|0,$e.bytes=n-r+1,e}var Io=Pt,Uo=128,ke=127;function Pt(t,r){var n=0,r=r||0,o=0,s=r,a,u=t.length;do{if(s>=u)throw Pt.bytes=0,new RangeError("Could not decode varint");a=t[s++],n+=o<28?(a&ke)<<o:(a&ke)*Math.pow(2,o),o+=7}while(a>=Uo);return Pt.bytes=s-r,n}var To=Math.pow(2,7),Fo=Math.pow(2,14),No=Math.pow(2,21),Lo=Math.pow(2,28),Oo=Math.pow(2,35),Ho=Math.pow(2,42),zo=Math.pow(2,49),Mo=Math.pow(2,56),qo=Math.pow(2,63),$o=function(t){return t<To?1:t<Fo?2:t<No?3:t<Lo?4:t<Oo?5:t<Ho?6:t<zo?7:t<Mo?8:t<qo?9:10},ko={encode:mo,decode:Io,encodingLength:$o},Re=ko;const je=(t,e,n=0)=>(Re.encode(t,e,n),e),Ze=t=>Re.encodingLength(t),Qt=(t,e)=>{const n=e.byteLength,r=Ze(t),o=r+Ze(n),s=new Uint8Array(o+n);return je(t,s,0),je(n,s,r),s.set(e,o),new Ro(t,n,e,s)};class Ro{constructor(e,n,r,o){this.code=e,this.size=n,this.digest=r,this.bytes=o}}const Ge=({name:t,code:e,encode:n})=>new jo(t,e,n);class jo{constructor(e,n,r){this.name=e,this.code=n,this.encode=r}digest(e){if(e instanceof Uint8Array){const n=this.encode(e);return n instanceof Uint8Array?Qt(this.code,n):n.then(r=>Qt(this.code,r))}else throw Error("Unknown type, must be binary type")}}const Ve=t=>async e=>new Uint8Array(await crypto.subtle.digest(t,e)),Zo=Ge({name:"sha2-256",code:18,encode:Ve("SHA-256")}),Go=Ge({name:"sha2-512",code:19,encode:Ve("SHA-512")});var Vo=Object.freeze({__proto__:null,sha256:Zo,sha512:Go});const Ye=0,Yo="identity",Je=He,Jo=t=>Qt(Ye,Je(t)),Ko={code:Ye,name:Yo,encode:Je,digest:Jo};var Wo=Object.freeze({__proto__:null,identity:Ko});new TextEncoder,new TextDecoder;const Ke={...kr,...jr,...Gr,...Yr,...Wr,...io,...ao,...ho,...Eo,...Ao};({...Vo,...Wo});function We(t,e,n,r){return{name:t,prefix:e,encoder:{name:t,prefix:e,encode:n},decoder:{decode:r}}}const Xe=We("utf8","u",t=>"u"+new TextDecoder("utf8").decode(t),t=>new TextEncoder().encode(t.substring(1))),index_es_te=We("ascii","a",t=>{let e="a";for(let n=0;n<t.length;n++)e+=String.fromCharCode(t[n]);return e},t=>{t=t.substring(1);const e=Le(t.length);for(let n=0;n<t.length;n++)e[n]=t.charCodeAt(n);return e}),Pe={utf8:Xe,"utf-8":Xe,hex:Ke.base16,latin1:index_es_te,ascii:index_es_te,binary:index_es_te,...Ke};function ct(t,e="utf8"){const n=Pe[e];if(!n)throw new Error(`Unsupported encoding "${e}"`);return(e==="utf8"||e==="utf-8")&&globalThis.Buffer!=null&&globalThis.Buffer.from!=null?globalThis.Buffer.from(t.buffer,t.byteOffset,t.byteLength).toString("utf8"):n.encoder.encode(t).substring(1)}function rt(t,e="utf8"){const n=Pe[e];if(!n)throw new Error(`Unsupported encoding "${e}"`);return(e==="utf8"||e==="utf-8")&&globalThis.Buffer!=null&&globalThis.Buffer.from!=null?Xt(globalThis.Buffer.from(t,"utf-8")):n.decoder.decode(`${n.prefix}${t}`)}function lt(t){return safeJsonParse(ct(rt(t,Dt),Gt))}function bt(t){return ct(rt(safeJsonStringify(t),Gt),Dt)}function Qe(t){const e=rt(Wt,dt),n=Kt+ct(Oe([e,t]),dt);return[Yt,Jt,n].join(Vt)}function tn(t){const[e,n,r]=t.split(Vt);if(e!==Yt||n!==Jt)throw new Error('Issuer must be a DID with method "key"');if(r.slice(0,1)!==Kt)throw new Error("Issuer must be a key in mulicodec format");const o=rt(r.slice(1),dt);if(ct(o.slice(0,2),dt)!==Wt)throw new Error('Issuer must be a public key with type "Ed25519"');const s=o.slice(2);if(s.length!==Fe)throw new Error("Issuer must be a public key with length 32 bytes");return s}function en(t){return ct(t,Dt)}function nn(t){return rt(t,Dt)}function rn(t){return rt([bt(t.header),bt(t.payload)].join(ut),xt)}function Xo(t){const e=ct(t,xt).split(ut),n=lt(e[0]),r=lt(e[1]);return{header:n,payload:r}}function on(t){return[bt(t.header),bt(t.payload),en(t.signature)].join(ut)}function sn(t){const e=t.split(ut),n=lt(e[0]),r=lt(e[1]),o=nn(e[2]),s=rt(e.slice(0,2).join(ut),xt);return{header:n,payload:r,signature:o,data:s}}function Po(t=he(Ne)){const e=Rt.getPublicKey(t);return{secretKey:Oe([t,e]),publicKey:e}}async function Qo(t,e,n,r,o=(0,cjs.fromMiliseconds)(Date.now())){const s={alg:jt,typ:Zt},a=Qe(r.publicKey),u=o+n,i={iss:a,sub:t,aud:e,iat:o,exp:u},D=rn({header:s,payload:i}),c=Rt.sign(D,r.secretKey.slice(0,32));return on({header:s,payload:i,signature:c})}async function ts(t){const{header:e,payload:n,data:r,signature:o}=sn(t);if(e.alg!==jt||e.typ!==Zt)throw new Error("JWT must use EdDSA algorithm");const s=tn(n.iss);return Rt.verify(o,r,s)}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/uint8arrays/esm/src/alloc.js
function alloc(size = 0) {
  if (globalThis.Buffer != null && globalThis.Buffer.alloc != null) {
    return globalThis.Buffer.alloc(size);
  }
  return new Uint8Array(size);
}
function allocUnsafe(size = 0) {
  if (globalThis.Buffer != null && globalThis.Buffer.allocUnsafe != null) {
    return globalThis.Buffer.allocUnsafe(size);
  }
  return new Uint8Array(size);
}
;// ./node_modules/uint8arrays/esm/src/concat.js

function concat(arrays, length) {
  if (!length) {
    length = arrays.reduce((acc, curr) => acc + curr.length, 0);
  }
  const output = allocUnsafe(length);
  let offset = 0;
  for (const arr of arrays) {
    output.set(arr, offset);
    offset += arr.length;
  }
  return output;
}
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/bases/base.js + 1 modules
var bases_base = __webpack_require__(52071);
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/bytes.js
var bytes = __webpack_require__(92081);
;// ./node_modules/multiformats/esm/src/bases/identity.js


const identity = (0,bases_base/* from */.HT)({
  prefix: '\0',
  name: 'identity',
  encode: buf => (0,bytes/* toString */.dI)(buf),
  decode: str => (0,bytes/* fromString */.sH)(str)
});
;// ./node_modules/multiformats/esm/src/bases/base2.js

const base2 = (0,bases_base/* rfc4648 */.yE)({
  prefix: '0',
  name: 'base2',
  alphabet: '01',
  bitsPerChar: 1
});
;// ./node_modules/multiformats/esm/src/bases/base8.js

const base8 = (0,bases_base/* rfc4648 */.yE)({
  prefix: '7',
  name: 'base8',
  alphabet: '01234567',
  bitsPerChar: 3
});
;// ./node_modules/multiformats/esm/src/bases/base10.js

const base10 = (0,bases_base/* baseX */._Q)({
  prefix: '9',
  name: 'base10',
  alphabet: '0123456789'
});
;// ./node_modules/multiformats/esm/src/bases/base16.js

const base16 = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'f',
  name: 'base16',
  alphabet: '0123456789abcdef',
  bitsPerChar: 4
});
const base16upper = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'F',
  name: 'base16upper',
  alphabet: '0123456789ABCDEF',
  bitsPerChar: 4
});
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/bases/base32.js
var base32 = __webpack_require__(33431);
;// ./node_modules/multiformats/esm/src/bases/base36.js

const base36 = (0,bases_base/* baseX */._Q)({
  prefix: 'k',
  name: 'base36',
  alphabet: '0123456789abcdefghijklmnopqrstuvwxyz'
});
const base36upper = (0,bases_base/* baseX */._Q)({
  prefix: 'K',
  name: 'base36upper',
  alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
});
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/bases/base58.js
var base58 = __webpack_require__(52807);
;// ./node_modules/multiformats/esm/src/bases/base64.js

const base64 = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'm',
  name: 'base64',
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  bitsPerChar: 6
});
const base64pad = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'M',
  name: 'base64pad',
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
  bitsPerChar: 6
});
const base64url = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'u',
  name: 'base64url',
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  bitsPerChar: 6
});
const base64urlpad = (0,bases_base/* rfc4648 */.yE)({
  prefix: 'U',
  name: 'base64urlpad',
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=',
  bitsPerChar: 6
});
;// ./node_modules/multiformats/esm/src/bases/base256emoji.js

const alphabet = Array.from('\uD83D\uDE80\uD83E\uDE90\u2604\uD83D\uDEF0\uD83C\uDF0C\uD83C\uDF11\uD83C\uDF12\uD83C\uDF13\uD83C\uDF14\uD83C\uDF15\uD83C\uDF16\uD83C\uDF17\uD83C\uDF18\uD83C\uDF0D\uD83C\uDF0F\uD83C\uDF0E\uD83D\uDC09\u2600\uD83D\uDCBB\uD83D\uDDA5\uD83D\uDCBE\uD83D\uDCBF\uD83D\uDE02\u2764\uD83D\uDE0D\uD83E\uDD23\uD83D\uDE0A\uD83D\uDE4F\uD83D\uDC95\uD83D\uDE2D\uD83D\uDE18\uD83D\uDC4D\uD83D\uDE05\uD83D\uDC4F\uD83D\uDE01\uD83D\uDD25\uD83E\uDD70\uD83D\uDC94\uD83D\uDC96\uD83D\uDC99\uD83D\uDE22\uD83E\uDD14\uD83D\uDE06\uD83D\uDE44\uD83D\uDCAA\uD83D\uDE09\u263A\uD83D\uDC4C\uD83E\uDD17\uD83D\uDC9C\uD83D\uDE14\uD83D\uDE0E\uD83D\uDE07\uD83C\uDF39\uD83E\uDD26\uD83C\uDF89\uD83D\uDC9E\u270C\u2728\uD83E\uDD37\uD83D\uDE31\uD83D\uDE0C\uD83C\uDF38\uD83D\uDE4C\uD83D\uDE0B\uD83D\uDC97\uD83D\uDC9A\uD83D\uDE0F\uD83D\uDC9B\uD83D\uDE42\uD83D\uDC93\uD83E\uDD29\uD83D\uDE04\uD83D\uDE00\uD83D\uDDA4\uD83D\uDE03\uD83D\uDCAF\uD83D\uDE48\uD83D\uDC47\uD83C\uDFB6\uD83D\uDE12\uD83E\uDD2D\u2763\uD83D\uDE1C\uD83D\uDC8B\uD83D\uDC40\uD83D\uDE2A\uD83D\uDE11\uD83D\uDCA5\uD83D\uDE4B\uD83D\uDE1E\uD83D\uDE29\uD83D\uDE21\uD83E\uDD2A\uD83D\uDC4A\uD83E\uDD73\uD83D\uDE25\uD83E\uDD24\uD83D\uDC49\uD83D\uDC83\uD83D\uDE33\u270B\uD83D\uDE1A\uD83D\uDE1D\uD83D\uDE34\uD83C\uDF1F\uD83D\uDE2C\uD83D\uDE43\uD83C\uDF40\uD83C\uDF37\uD83D\uDE3B\uD83D\uDE13\u2B50\u2705\uD83E\uDD7A\uD83C\uDF08\uD83D\uDE08\uD83E\uDD18\uD83D\uDCA6\u2714\uD83D\uDE23\uD83C\uDFC3\uD83D\uDC90\u2639\uD83C\uDF8A\uD83D\uDC98\uD83D\uDE20\u261D\uD83D\uDE15\uD83C\uDF3A\uD83C\uDF82\uD83C\uDF3B\uD83D\uDE10\uD83D\uDD95\uD83D\uDC9D\uD83D\uDE4A\uD83D\uDE39\uD83D\uDDE3\uD83D\uDCAB\uD83D\uDC80\uD83D\uDC51\uD83C\uDFB5\uD83E\uDD1E\uD83D\uDE1B\uD83D\uDD34\uD83D\uDE24\uD83C\uDF3C\uD83D\uDE2B\u26BD\uD83E\uDD19\u2615\uD83C\uDFC6\uD83E\uDD2B\uD83D\uDC48\uD83D\uDE2E\uD83D\uDE46\uD83C\uDF7B\uD83C\uDF43\uD83D\uDC36\uD83D\uDC81\uD83D\uDE32\uD83C\uDF3F\uD83E\uDDE1\uD83C\uDF81\u26A1\uD83C\uDF1E\uD83C\uDF88\u274C\u270A\uD83D\uDC4B\uD83D\uDE30\uD83E\uDD28\uD83D\uDE36\uD83E\uDD1D\uD83D\uDEB6\uD83D\uDCB0\uD83C\uDF53\uD83D\uDCA2\uD83E\uDD1F\uD83D\uDE41\uD83D\uDEA8\uD83D\uDCA8\uD83E\uDD2C\u2708\uD83C\uDF80\uD83C\uDF7A\uD83E\uDD13\uD83D\uDE19\uD83D\uDC9F\uD83C\uDF31\uD83D\uDE16\uD83D\uDC76\uD83E\uDD74\u25B6\u27A1\u2753\uD83D\uDC8E\uD83D\uDCB8\u2B07\uD83D\uDE28\uD83C\uDF1A\uD83E\uDD8B\uD83D\uDE37\uD83D\uDD7A\u26A0\uD83D\uDE45\uD83D\uDE1F\uD83D\uDE35\uD83D\uDC4E\uD83E\uDD32\uD83E\uDD20\uD83E\uDD27\uD83D\uDCCC\uD83D\uDD35\uD83D\uDC85\uD83E\uDDD0\uD83D\uDC3E\uD83C\uDF52\uD83D\uDE17\uD83E\uDD11\uD83C\uDF0A\uD83E\uDD2F\uD83D\uDC37\u260E\uD83D\uDCA7\uD83D\uDE2F\uD83D\uDC86\uD83D\uDC46\uD83C\uDFA4\uD83D\uDE47\uD83C\uDF51\u2744\uD83C\uDF34\uD83D\uDCA3\uD83D\uDC38\uD83D\uDC8C\uD83D\uDCCD\uD83E\uDD40\uD83E\uDD22\uD83D\uDC45\uD83D\uDCA1\uD83D\uDCA9\uD83D\uDC50\uD83D\uDCF8\uD83D\uDC7B\uD83E\uDD10\uD83E\uDD2E\uD83C\uDFBC\uD83E\uDD75\uD83D\uDEA9\uD83C\uDF4E\uD83C\uDF4A\uD83D\uDC7C\uD83D\uDC8D\uD83D\uDCE3\uD83E\uDD42');
const alphabetBytesToChars = alphabet.reduce((p, c, i) => {
  p[i] = c;
  return p;
}, []);
const alphabetCharsToBytes = alphabet.reduce((p, c, i) => {
  p[c.codePointAt(0)] = i;
  return p;
}, []);
function encode(data) {
  return data.reduce((p, c) => {
    p += alphabetBytesToChars[c];
    return p;
  }, '');
}
function decode(str) {
  const byts = [];
  for (const char of str) {
    const byt = alphabetCharsToBytes[char.codePointAt(0)];
    if (byt === undefined) {
      throw new Error(`Non-base256emoji character: ${ char }`);
    }
    byts.push(byt);
  }
  return new Uint8Array(byts);
}
const base256emoji = (0,bases_base/* from */.HT)({
  prefix: '\uD83D\uDE80',
  name: 'base256emoji',
  encode,
  decode
});
// EXTERNAL MODULE: external "crypto"
var external_crypto_ = __webpack_require__(76982);
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/hashes/digest.js
var hashes_digest = __webpack_require__(14403);
;// ./node_modules/multiformats/esm/src/hashes/hasher.js

const from = ({name, code, encode}) => new Hasher(name, code, encode);
class Hasher {
  constructor(name, code, encode) {
    this.name = name;
    this.code = code;
    this.encode = encode;
  }
  digest(input) {
    if (input instanceof Uint8Array) {
      const result = this.encode(input);
      return result instanceof Uint8Array ? hashes_digest/* create */.vt(this.code, result) : result.then(digest => hashes_digest/* create */.vt(this.code, digest));
    } else {
      throw Error('Unknown type, must be binary type');
    }
  }
}
;// ./node_modules/multiformats/esm/src/hashes/sha2.js



const sha256 = from({
  name: 'sha2-256',
  code: 18,
  encode: input => (0,bytes/* coerce */.au)(external_crypto_.createHash('sha256').update(input).digest())
});
const sha512 = from({
  name: 'sha2-512',
  code: 19,
  encode: input => (0,bytes/* coerce */.au)(external_crypto_.createHash('sha512').update(input).digest())
});
;// ./node_modules/multiformats/esm/src/hashes/identity.js


const code = 0;
const identity_name = 'identity';
const identity_encode = bytes/* coerce */.au;
const digest = input => hashes_digest/* create */.vt(code, identity_encode(input));
const identity_identity = {
  code,
  name: identity_name,
  encode: identity_encode,
  digest
};
;// ./node_modules/multiformats/esm/src/codecs/raw.js

const raw_name = 'raw';
const raw_code = 85;
const raw_encode = node => (0,bytes/* coerce */.au)(node);
const raw_decode = data => (0,bytes/* coerce */.au)(data);
;// ./node_modules/multiformats/esm/src/codecs/json.js
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const json_name = 'json';
const json_code = 512;
const json_encode = node => textEncoder.encode(JSON.stringify(node));
const json_decode = data => JSON.parse(textDecoder.decode(data));
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/cid.js
var cid = __webpack_require__(54070);
// EXTERNAL MODULE: ./node_modules/multiformats/esm/src/varint.js + 1 modules
var varint = __webpack_require__(74973);
;// ./node_modules/multiformats/esm/src/index.js






;// ./node_modules/multiformats/esm/src/basics.js















const bases = {
  ...identity_namespaceObject,
  ...base2_namespaceObject,
  ...base8_namespaceObject,
  ...base10_namespaceObject,
  ...base16_namespaceObject,
  ...base32,
  ...base36_namespaceObject,
  ...base58,
  ...base64_namespaceObject,
  ...base256emoji_namespaceObject
};
const hashes = {
  ...sha2_namespaceObject,
  ...hashes_identity_namespaceObject
};
const codecs = {
  raw: raw_namespaceObject,
  json: json_namespaceObject
};

;// ./node_modules/uint8arrays/esm/src/util/bases.js


function createCodec(name, prefix, encode, decode) {
  return {
    name,
    prefix,
    encoder: {
      name,
      prefix,
      encode
    },
    decoder: { decode }
  };
}
const string = createCodec('utf8', 'u', buf => {
  const decoder = new TextDecoder('utf8');
  return 'u' + decoder.decode(buf);
}, str => {
  const encoder = new TextEncoder();
  return encoder.encode(str.substring(1));
});
const ascii = createCodec('ascii', 'a', buf => {
  let string = 'a';
  for (let i = 0; i < buf.length; i++) {
    string += String.fromCharCode(buf[i]);
  }
  return string;
}, str => {
  str = str.substring(1);
  const buf = allocUnsafe(str.length);
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i);
  }
  return buf;
});
const BASES = {
  utf8: string,
  'utf-8': string,
  hex: bases.base16,
  latin1: ascii,
  ascii: ascii,
  binary: ascii,
  ...bases
};
/* harmony default export */ const util_bases = (BASES);
;// ./node_modules/uint8arrays/esm/src/from-string.js

function fromString(string, encoding = 'utf8') {
  const base = util_bases[encoding];
  if (!base) {
    throw new Error(`Unsupported encoding "${ encoding }"`);
  }
  if ((encoding === 'utf8' || encoding === 'utf-8') && globalThis.Buffer != null && globalThis.Buffer.from != null) {
    return globalThis.Buffer.from(string, 'utf8');
  }
  return base.decoder.decode(`${ base.prefix }${ string }`);
}
;// ./node_modules/uint8arrays/esm/src/to-string.js

function to_string_toString(array, encoding = 'utf8') {
  const base = util_bases[encoding];
  if (!base) {
    throw new Error(`Unsupported encoding "${ encoding }"`);
  }
  if ((encoding === 'utf8' || encoding === 'utf-8') && globalThis.Buffer != null && globalThis.Buffer.from != null) {
    return globalThis.Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('utf8');
  }
  return base.encoder.encode(array).substring(1);
}
;// ./node_modules/uint8arrays/esm/src/index.js







// EXTERNAL MODULE: ./node_modules/elliptic/lib/elliptic.js
var elliptic = __webpack_require__(86729);
;// ./node_modules/@walletconnect/relay-api/dist/index.es.js
function e(s,r,i="string"){if(!s[r]||typeof s[r]!==i)throw new Error(`Missing or invalid "${r}" param`)}function l(s,r){let i=!0;return r.forEach(t=>{t in s||(i=!1)}),i}function f(s,r){return Array.isArray(s)?s.length===r:Object.keys(s).length===r}function w(s,r){return Array.isArray(s)?s.length>=r:Object.keys(s).length>=r}function u(s,r,i){return(i.length?w(s,r.length):f(s,r.length))?l(s,r):!1}function n(s,r,i="_"){const t=s.split(i);return t[t.length-1].trim().toLowerCase()===r.trim().toLowerCase()}function R(s){return b(s.method)&&a(s.params)}function b(s){return n(s,"subscribe")}function a(s){return u(s,["topic"],[])}function index_es_P(s){return c(s.method)&&h(s.params)}function c(s){return n(s,"publish")}function h(s){return u(s,["message","topic","ttl"],["prompt","tag"])}function _(s){return o(s.method)&&p(s.params)}function o(s){return n(s,"unsubscribe")}function p(s){return u(s,["id","topic"],[])}function S(s){return m(s.method)&&d(s.params)}function m(s){return n(s,"subscription")}function d(s){return u(s,["id","data"],[])}function g(s){if(!b(s.method))throw new Error("JSON-RPC Request has invalid subscribe method");if(!a(s.params))throw new Error("JSON-RPC Request has invalid subscribe params");const r=s.params;return e(r,"topic"),r}function q(s){if(!c(s.method))throw new Error("JSON-RPC Request has invalid publish method");if(!h(s.params))throw new Error("JSON-RPC Request has invalid publish params");const r=s.params;return e(r,"topic"),e(r,"message"),e(r,"ttl","number"),r}function E(s){if(!o(s.method))throw new Error("JSON-RPC Request has invalid unsubscribe method");if(!p(s.params))throw new Error("JSON-RPC Request has invalid unsubscribe params");const r=s.params;return e(r,"id"),r}function index_es_k(s){if(!m(s.method))throw new Error("JSON-RPC Request has invalid subscription method");if(!d(s.params))throw new Error("JSON-RPC Request has invalid subscription params");const r=s.params;return e(r,"id"),e(r,"data"),r}const C={waku:{publish:"waku_publish",batchPublish:"waku_batchPublish",subscribe:"waku_subscribe",batchSubscribe:"waku_batchSubscribe",subscription:"waku_subscription",unsubscribe:"waku_unsubscribe",batchUnsubscribe:"waku_batchUnsubscribe",batchFetchMessages:"waku_batchFetchMessages"},irn:{publish:"irn_publish",batchPublish:"irn_batchPublish",subscribe:"irn_subscribe",batchSubscribe:"irn_batchSubscribe",subscription:"irn_subscription",unsubscribe:"irn_unsubscribe",batchUnsubscribe:"irn_batchUnsubscribe",batchFetchMessages:"irn_batchFetchMessages"},iridium:{publish:"iridium_publish",batchPublish:"iridium_batchPublish",subscribe:"iridium_subscribe",batchSubscribe:"iridium_batchSubscribe",subscription:"iridium_subscription",unsubscribe:"iridium_unsubscribe",batchUnsubscribe:"iridium_batchUnsubscribe",batchFetchMessages:"iridium_batchFetchMessages"}};
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/utils/dist/index.es.js
const index_es_Pe=":";function index_es_Ye(e){const[t,n]=e.split(index_es_Pe);return{namespace:t,reference:n}}function index_es_Dt(e){const{namespace:t,reference:n}=e;return[t,n].join(index_es_Pe)}function index_es_Xe(e){const[t,n,r]=e.split(index_es_Pe);return{namespace:t,reference:n,address:r}}function index_es_Mt(e){const{namespace:t,reference:n,address:r}=e;return[t,n,r].join(index_es_Pe)}function index_es_Ze(e,t){const n=[];return e.forEach(r=>{const o=t(r);n.includes(o)||n.push(o)}),n}function index_es_Vt(e){const{address:t}=index_es_Xe(e);return t}function index_es_Ht(e){const{namespace:t,reference:n}=index_es_Xe(e);return index_es_Dt({namespace:t,reference:n})}function index_es_Vr(e,t){const{namespace:n,reference:r}=index_es_Ye(t);return index_es_Mt({namespace:n,reference:r,address:e})}function index_es_Hr(e){return index_es_Ze(e,index_es_Vt)}function index_es_Kt(e){return index_es_Ze(e,index_es_Ht)}function index_es_Kr(e,t=[]){const n=[];return Object.keys(e).forEach(r=>{if(t.length&&!t.includes(r))return;const o=e[r];n.push(...o.accounts)}),n}function index_es_Fr(e,t=[]){const n=[];return Object.keys(e).forEach(r=>{if(t.length&&!t.includes(r))return;const o=e[r];n.push(...index_es_Kt(o.accounts))}),n}function index_es_qr(e,t=[]){const n=[];return Object.keys(e).forEach(r=>{if(t.length&&!t.includes(r))return;const o=e[r];n.push(...index_es_Be(r,o))}),n}function index_es_Be(e,t){return e.includes(":")?[e]:t.chains||[]}const index_es_Ft="ReactNative",index_es_H={reactNative:"react-native",node:"node",browser:"browser",unknown:"unknown"},index_es_Le=" ",index_es_Gr=":",index_es_qt="/",index_es_Qe=2,index_es_Wr=1e3,index_es_Gt="js";function et(){return typeof process<"u"&&typeof process.versions<"u"&&typeof process.versions.node<"u"}function ne(){return!(0,dist_cjs.getDocument)()&&!!(0,dist_cjs.getNavigator)()&&navigator.product===index_es_Ft}function index_es_zr(){return ne()&&typeof global<"u"&&typeof(global==null?void 0:global.Platform)<"u"&&(global==null?void 0:global.Platform.OS)==="android"}function index_es_Jr(){return ne()&&typeof global<"u"&&typeof(global==null?void 0:global.Platform)<"u"&&(global==null?void 0:global.Platform.OS)==="ios"}function index_es_Ae(){return!et()&&!!(0,dist_cjs.getNavigator)()&&!!(0,dist_cjs.getDocument)()}function ue(){return ne()?index_es_H.reactNative:et()?index_es_H.node:index_es_Ae()?index_es_H.browser:index_es_H.unknown}function index_es_Yr(){var e;try{return ne()&&typeof global<"u"&&typeof(global==null?void 0:global.Application)<"u"?(e=global.Application)==null?void 0:e.applicationId:void 0}catch{return}}function index_es_Wt(e,t){const n=new URLSearchParams(e);for(const r of Object.keys(t).sort())if(t.hasOwnProperty(r)){const o=t[r];o!==void 0&&n.set(r,o)}return n.toString()}function index_es_Xr(){return (0,window_metadata_dist_cjs/* getWindowMetadata */.g)()||{name:"",description:"",url:"",icons:[""]}}function index_es_Zr(e,t){var n;const r=ue(),o={protocol:e,version:t,env:r};return r==="browser"&&(o.host=((n=kt())==null?void 0:n.host)||"unknown"),o}function index_es_zt(){if(ue()===index_es_H.reactNative&&typeof global<"u"&&typeof(global==null?void 0:global.Platform)<"u"){const{OS:n,Version:r}=global.Platform;return[n,r].join("-")}const e=detect();if(e===null)return"unknown";const t=e.os?e.os.replace(" ","").toLowerCase():"unknown";return e.type==="browser"?[t,e.name,e.version].join("-"):[t,e.version].join("-")}function index_es_Jt(){var e;const t=ue();return t===index_es_H.browser?[t,((e=(0,dist_cjs.getLocation)())==null?void 0:e.host)||"unknown"].join(":"):t}function index_es_Yt(e,t,n){const r=index_es_zt(),o=index_es_Jt();return[[e,t].join("-"),[index_es_Gt,n].join("-"),r,o].join("/")}function index_es_Qr({protocol:e,version:t,relayUrl:n,sdkVersion:r,auth:o,projectId:s,useOnCloseEvent:i,bundleId:c,packageName:u}){const a=n.split("?"),l=index_es_Yt(e,t,r),f={auth:o,ua:l,projectId:s,useOnCloseEvent:i||void 0,packageName:u||void 0,bundleId:c||void 0},d=index_es_Wt(a[1]||"",f);return a[0]+"?"+d}function index_es_eo(e){let t=(e.match(/^[^:]+(?=:\/\/)/gi)||[])[0];const n=typeof t<"u"?e.split("://")[1]:e;return t=t==="wss"?"https":"http",[t,n].join("://")}function index_es_to(e,t,n){if(!e[t]||typeof e[t]!==n)throw new Error(`Missing or invalid "${t}" param`)}function index_es_Xt(e,t=index_es_Qe){return index_es_Zt(e.split(index_es_qt),t)}function index_es_no(e){return index_es_Xt(e).join(index_es_Le)}function re(e,t){return e.filter(n=>t.includes(n)).length===e.length}function index_es_Zt(e,t=index_es_Qe){return e.slice(Math.max(e.length-t,0))}function index_es_ro(e){return Object.fromEntries(e.entries())}function index_es_oo(e){return new Map(Object.entries(e))}function index_es_so(e,t){const n={};return Object.keys(e).forEach(r=>{n[r]=t(e[r])}),n}const index_es_io=e=>e;function index_es_Qt(e){return e.trim().replace(/^\w/,t=>t.toUpperCase())}function index_es_co(e){return e.split(index_es_Le).map(t=>index_es_Qt(t)).join(index_es_Le)}function index_es_ao(e=cjs.FIVE_MINUTES,t){const n=(0,cjs.toMiliseconds)(e||cjs.FIVE_MINUTES);let r,o,s,i;return{resolve:c=>{s&&r&&(clearTimeout(s),r(c),i=Promise.resolve(c))},reject:c=>{s&&o&&(clearTimeout(s),o(c))},done:()=>new Promise((c,u)=>{if(i)return c(i);s=setTimeout(()=>{const a=new Error(t);i=Promise.reject(a),u(a)},n),r=c,o=u})}}function index_es_uo(e,t,n){return new Promise(async(r,o)=>{const s=setTimeout(()=>o(new Error(n)),t);try{const i=await e;r(i)}catch(i){o(i)}clearTimeout(s)})}function tt(e,t){if(typeof t=="string"&&t.startsWith(`${e}:`))return t;if(e.toLowerCase()==="topic"){if(typeof t!="string")throw new Error('Value must be "string" for expirer target type: topic');return`topic:${t}`}else if(e.toLowerCase()==="id"){if(typeof t!="number")throw new Error('Value must be "number" for expirer target type: id');return`id:${t}`}throw new Error(`Unknown expirer target type: ${e}`)}function index_es_fo(e){return tt("topic",e)}function index_es_lo(e){return tt("id",e)}function index_es_ho(e){const[t,n]=e.split(":"),r={id:void 0,topic:void 0};if(t==="topic"&&typeof n=="string")r.topic=n;else if(t==="id"&&Number.isInteger(Number(n)))r.id=Number(n);else throw new Error(`Invalid target, expected id:number or topic:string, got ${t}:${n}`);return r}function index_es_po(e,t){return (0,cjs.fromMiliseconds)((t||Date.now())+(0,cjs.toMiliseconds)(e))}function index_es_go(e){return Date.now()>=(0,cjs.toMiliseconds)(e)}function index_es_yo(e,t){return`${e}${t?`:${t}`:""}`}function index_es_Q(e=[],t=[]){return[...new Set([...e,...t])]}async function index_es_mo({id:e,topic:t,wcDeepLink:n}){var r;try{if(!n)return;const o=typeof n=="string"?JSON.parse(n):n,s=o?.href;if(typeof s!="string")return;const i=index_es_en(s,e,t),c=ue();if(c===index_es_H.browser){if(!((r=(0,dist_cjs.getDocument)())!=null&&r.hasFocus())){console.warn("Document does not have focus, skipping deeplink.");return}index_es_tn(i)}else c===index_es_H.reactNative&&typeof(global==null?void 0:global.Linking)<"u"&&await global.Linking.openURL(i)}catch(o){console.error(o)}}function index_es_en(e,t,n){const r=`requestId=${t}&sessionTopic=${n}`;e.endsWith("/")&&(e=e.slice(0,-1));let o=`${e}`;if(e.startsWith("https://t.me")){const s=e.includes("?")?"&startapp=":"?startapp=";o=`${o}${s}${index_es_on(r,!0)}`}else o=`${o}/wc?${r}`;return o}function index_es_tn(e){let t="_self";index_es_rn()?t="_top":(index_es_nn()||e.startsWith("https://")||e.startsWith("http://"))&&(t="_blank"),window.open(e,t,"noreferrer noopener")}async function index_es_bo(e,t){let n="";try{if(index_es_Ae()&&(n=localStorage.getItem(t),n))return n;n=await e.getItem(t)}catch(r){console.error(r)}return n}function index_es_nt(e,t){return e.filter(n=>t.includes(n))}function index_es_wo(e,t){if(!e.includes(t))return null;const n=e.split(/([&,?,=])/),r=n.indexOf(t);return n[r+2]}function index_es_Eo(){return typeof crypto<"u"&&crypto!=null&&crypto.randomUUID?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu,e=>{const t=Math.random()*16|0;return(e==="x"?t:t&3|8).toString(16)})}function index_es_vo(){return typeof process<"u"&&process.env.IS_VITEST==="true"}function index_es_nn(){return typeof window<"u"&&(!!window.TelegramWebviewProxy||!!window.Telegram||!!window.TelegramWebviewProxyProto)}function index_es_rn(){try{return window.self!==window.top}catch{return!1}}function index_es_on(e,t=!1){const n=Buffer.from(e).toString("base64");return t?n.replace(/[=]/g,""):n}function index_es_rt(e){return Buffer.from(e,"base64").toString("utf-8")}function index_es_xo(e){return new Promise(t=>setTimeout(t,e))}function index_es_Ne(e){if(!Number.isSafeInteger(e)||e<0)throw new Error("positive integer expected, got "+e)}function index_es_Io(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function index_es_je(e,...t){if(!index_es_Io(e))throw new Error("Uint8Array expected");if(t.length>0&&!t.includes(e.length))throw new Error("Uint8Array expected of length "+t+", got length="+e.length)}function ot(e){if(typeof e!="function"||typeof e.create!="function")throw new Error("Hash should be wrapped by utils.wrapConstructor");index_es_Ne(e.outputLen),index_es_Ne(e.blockLen)}function index_es_me(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function index_es_sn(e,t){index_es_je(e);const n=t.outputLen;if(e.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}const dist_index_es_Ce=BigInt(2**32-1),cn=BigInt(32);function index_es_Oo(e,t=!1){return t?{h:Number(e&dist_index_es_Ce),l:Number(e>>cn&dist_index_es_Ce)}:{h:Number(e>>cn&dist_index_es_Ce)|0,l:Number(e&dist_index_es_Ce)|0}}function index_es_Ao(e,t=!1){let n=new Uint32Array(e.length),r=new Uint32Array(e.length);for(let o=0;o<e.length;o++){const{h:s,l:i}=index_es_Oo(e[o],t);[n[o],r[o]]=[s,i]}return[n,r]}const index_es_No=(e,t,n)=>e<<n|t>>>32-n,index_es_So=(e,t,n)=>t<<n|e>>>32-n,index_es_Uo=(e,t,n)=>t<<n-32|e>>>64-n,index_es_o=(e,t,n)=>e<<n-32|t>>>64-n,index_es_be=typeof globalThis=="object"&&"crypto"in globalThis?globalThis.crypto:void 0;function index_es_To(e){return new Uint32Array(e.buffer,e.byteOffset,Math.floor(e.byteLength/4))}function st(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}function index_es_J(e,t){return e<<32-t|e>>>t}const an=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function index_es_$o(e){return e<<24&4278190080|e<<8&16711680|e>>>8&65280|e>>>24&255}function un(e){for(let t=0;t<e.length;t++)e[t]=index_es_$o(e[t])}function index_es_Ro(e){if(typeof e!="string")throw new Error("utf8ToBytes expected string, got "+typeof e);return new Uint8Array(new TextEncoder().encode(e))}function index_es_we(e){return typeof e=="string"&&(e=index_es_Ro(e)),index_es_je(e),e}class index_es_it{clone(){return this._cloneInto()}}function fn(e){const t=r=>e().update(index_es_we(r)).digest(),n=e();return t.outputLen=n.outputLen,t.blockLen=n.blockLen,t.create=()=>e(),t}function index_es_Se(e=32){if(index_es_be&&typeof index_es_be.getRandomValues=="function")return index_es_be.getRandomValues(new Uint8Array(e));if(index_es_be&&typeof index_es_be.randomBytes=="function")return index_es_be.randomBytes(e);throw new Error("crypto.getRandomValues must be defined")}const ln=[],dn=[],hn=[],index_es_Po=BigInt(0),index_es_Ue=BigInt(1),index_es_Bo=BigInt(2),index_es_Lo=BigInt(7),index_es_jo=BigInt(256),index_es_Co=BigInt(113);for(let e=0,t=index_es_Ue,n=1,r=0;e<24;e++){[n,r]=[r,(2*n+3*r)%5],ln.push(2*(5*r+n)),dn.push((e+1)*(e+2)/2%64);let o=index_es_Po;for(let s=0;s<7;s++)t=(t<<index_es_Ue^(t>>index_es_Lo)*index_es_Co)%index_es_jo,t&index_es_Bo&&(o^=index_es_Ue<<(index_es_Ue<<BigInt(s))-index_es_Ue);hn.push(o)}const[index_es_ko,index_es_Do]=index_es_Ao(hn,!0),pn=(e,t,n)=>n>32?index_es_Uo(e,t,n):index_es_No(e,t,n),index_es_gn=(e,t,n)=>n>32?index_es_o(e,t,n):index_es_So(e,t,n);function index_es_Mo(e,t=24){const n=new Uint32Array(10);for(let r=24-t;r<24;r++){for(let i=0;i<10;i++)n[i]=e[i]^e[i+10]^e[i+20]^e[i+30]^e[i+40];for(let i=0;i<10;i+=2){const c=(i+8)%10,u=(i+2)%10,a=n[u],l=n[u+1],f=pn(a,l,1)^n[c],d=index_es_gn(a,l,1)^n[c+1];for(let g=0;g<50;g+=10)e[i+g]^=f,e[i+g+1]^=d}let o=e[2],s=e[3];for(let i=0;i<24;i++){const c=dn[i],u=pn(o,s,c),a=index_es_gn(o,s,c),l=ln[i];o=e[l],s=e[l+1],e[l]=u,e[l+1]=a}for(let i=0;i<50;i+=10){for(let c=0;c<10;c++)n[c]=e[i+c];for(let c=0;c<10;c++)e[i+c]^=~n[(c+2)%10]&n[(c+4)%10]}e[0]^=index_es_ko[r],e[1]^=index_es_Do[r]}n.fill(0)}class index_es_Lt extends index_es_it{constructor(t,n,r,o=!1,s=24){if(super(),this.blockLen=t,this.suffix=n,this.outputLen=r,this.enableXOF=o,this.rounds=s,this.pos=0,this.posOut=0,this.finished=!1,this.destroyed=!1,index_es_Ne(r),0>=this.blockLen||this.blockLen>=200)throw new Error("Sha3 supports only keccak-f1600 function");this.state=new Uint8Array(200),this.state32=index_es_To(this.state)}keccak(){an||un(this.state32),index_es_Mo(this.state32,this.rounds),an||un(this.state32),this.posOut=0,this.pos=0}update(t){index_es_me(this);const{blockLen:n,state:r}=this;t=index_es_we(t);const o=t.length;for(let s=0;s<o;){const i=Math.min(n-this.pos,o-s);for(let c=0;c<i;c++)r[this.pos++]^=t[s++];this.pos===n&&this.keccak()}return this}finish(){if(this.finished)return;this.finished=!0;const{state:t,suffix:n,pos:r,blockLen:o}=this;t[r]^=n,(n&128)!==0&&r===o-1&&this.keccak(),t[o-1]^=128,this.keccak()}writeInto(t){index_es_me(this,!1),index_es_je(t),this.finish();const n=this.state,{blockLen:r}=this;for(let o=0,s=t.length;o<s;){this.posOut>=r&&this.keccak();const i=Math.min(r-this.posOut,s-o);t.set(n.subarray(this.posOut,this.posOut+i),o),this.posOut+=i,o+=i}return t}xofInto(t){if(!this.enableXOF)throw new Error("XOF is not possible for this instance");return this.writeInto(t)}xof(t){return index_es_Ne(t),this.xofInto(new Uint8Array(t))}digestInto(t){if(index_es_sn(t,this),this.finished)throw new Error("digest() was already called");return this.writeInto(t),this.destroy(),t}digest(){return this.digestInto(new Uint8Array(this.outputLen))}destroy(){this.destroyed=!0,this.state.fill(0)}_cloneInto(t){const{blockLen:n,suffix:r,outputLen:o,rounds:s,enableXOF:i}=this;return t||(t=new index_es_Lt(n,r,o,i,s)),t.state32.set(this.state32),t.pos=this.pos,t.posOut=this.posOut,t.finished=this.finished,t.rounds=s,t.suffix=r,t.outputLen=o,t.enableXOF=i,t.destroyed=this.destroyed,t}}const index_es_Vo=(e,t,n)=>fn(()=>new index_es_Lt(t,e,n)),index_es_Ho=index_es_Vo(1,136,256/8),index_es_Ko="https://rpc.walletconnect.org/v1";function index_es_ct(e){const t=`Ethereum Signed Message:
${e.length}`,n=new TextEncoder().encode(t+e);return"0x"+Buffer.from(index_es_Ho(n)).toString("hex")}async function index_es_yn(e,t,n,r,o,s){switch(n.t){case"eip191":return await index_es_mn(e,t,n.s);case"eip1271":return await bn(e,t,n.s,r,o,s);default:throw new Error(`verifySignature failed: Attempted to verify CacaoSignature with unknown type: ${n.t}`)}}async function index_es_mn(e,t,n){return(await recoverAddress({hash:index_es_ct(t),signature:n})).toLowerCase()===e.toLowerCase()}async function bn(e,t,n,r,o,s){const i=index_es_Ye(r);if(!i.namespace||!i.reference)throw new Error(`isValidEip1271Signature failed: chainId must be in CAIP-2 format, received: ${r}`);try{const c="0x1626ba7e",u="0000000000000000000000000000000000000000000000000000000000000040",a="0000000000000000000000000000000000000000000000000000000000000041",l=n.substring(2),f=index_es_ct(t).substring(2),d=c+f+u+a+l,g=await fetch(`${s||index_es_Ko}/?chainId=${r}&projectId=${o}`,{method:"POST",body:JSON.stringify({id:index_es_Fo(),jsonrpc:"2.0",method:"eth_call",params:[{to:e,data:d},"latest"]})}),{result:y}=await g.json();return y?y.slice(0,c.length).toLowerCase()===c.toLowerCase():!1}catch(c){return console.error("isValidEip1271Signature: ",c),!1}}function index_es_Fo(){return Date.now()+Math.floor(Math.random()*1e3)}function index_es_qo(e){const t=atob(e),n=new Uint8Array(t.length);for(let i=0;i<t.length;i++)n[i]=t.charCodeAt(i);const r=n[0];if(r===0)throw new Error("No signatures found");const o=1+r*64;if(n.length<o)throw new Error("Transaction data too short for claimed signature count");if(n.length<100)throw new Error("Transaction too short");const s=Buffer.from(e,"base64").slice(1,65);return src_esm.encode(s)}var index_es_Go=Object.defineProperty,index_es_Wo=Object.defineProperties,index_es_zo=Object.getOwnPropertyDescriptors,wn=Object.getOwnPropertySymbols,index_es_Jo=Object.prototype.hasOwnProperty,index_es_Yo=Object.prototype.propertyIsEnumerable,index_es_En=(e,t,n)=>t in e?index_es_Go(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,at=(e,t)=>{for(var n in t||(t={}))index_es_Jo.call(t,n)&&index_es_En(e,n,t[n]);if(wn)for(var n of wn(t))index_es_Yo.call(t,n)&&index_es_En(e,n,t[n]);return e},index_es_vn=(e,t)=>index_es_Wo(e,index_es_zo(t));const index_es_Xo="did:pkh:",index_es_ke=e=>e?.split(":"),index_es_xn=e=>{const t=e&&index_es_ke(e);if(t)return e.includes(index_es_Xo)?t[3]:t[1]},index_es_In=e=>{const t=e&&index_es_ke(e);if(t)return t[2]+":"+t[3]},index_es_ut=e=>{const t=e&&index_es_ke(e);if(t)return t.pop()};async function index_es_Zo(e){const{cacao:t,projectId:n}=e,{s:r,p:o}=t,s=index_es_On(o,o.iss),i=index_es_ut(o.iss);return await index_es_yn(i,s,r,index_es_In(o.iss),n)}const index_es_On=(e,t)=>{const n=`${e.domain} wants you to sign in with your Ethereum account:`,r=index_es_ut(t);if(!e.aud&&!e.uri)throw new Error("Either `aud` or `uri` is required to construct the message");let o=e.statement||void 0;const s=`URI: ${e.aud||e.uri}`,i=`Version: ${e.version}`,c=`Chain ID: ${index_es_xn(t)}`,u=`Nonce: ${e.nonce}`,a=`Issued At: ${e.iat}`,l=e.exp?`Expiration Time: ${e.exp}`:void 0,f=e.nbf?`Not Before: ${e.nbf}`:void 0,d=e.requestId?`Request ID: ${e.requestId}`:void 0,g=e.resources?`Resources:${e.resources.map(h=>`
- ${h}`).join("")}`:void 0,y=index_es_Me(e.resources);if(y){const h=oe(y);o=index_es_dt(o,h)}return[n,r,"",o,"",s,i,c,u,a,l,f,d,g].filter(h=>h!=null).join(`
`)};function index_es_Qo(e,t,n){return n.includes("did:pkh:")||(n=`did:pkh:${n}`),{h:{t:"caip122"},p:{iss:n,domain:e.domain,aud:e.aud,version:e.version,nonce:e.nonce,iat:e.iat,statement:e.statement,requestId:e.requestId,resources:e.resources,nbf:e.nbf,exp:e.exp},s:t}}function es(e){var t;const{authPayload:n,chains:r,methods:o}=e,s=n.statement||"";if(!(r!=null&&r.length))return n;const i=n.chains,c=index_es_nt(i,r);if(!(c!=null&&c.length))throw new Error("No supported chains");const u=index_es_An(n.resources);if(!u)return n;Y(u);const a=index_es_Nn(u,"eip155");let l=n?.resources||[];if(a!=null&&a.length){const f=index_es_Sn(a),d=index_es_nt(f,o);if(!(d!=null&&d.length))throw new Error(`Supported methods don't satisfy the requested: ${JSON.stringify(f)}, supported: ${JSON.stringify(o)}`);const g=index_es_ft("request",d,{chains:c}),y=index_es_$n(u,"eip155",g);l=((t=n?.resources)==null?void 0:t.slice(0,-1))||[],l.push(index_es_De(y))}return index_es_vn(at({},n),{statement:index_es_Pn(s,index_es_Me(l)),chains:c,resources:n!=null&&n.resources||l.length>0?l:void 0})}function index_es_An(e){const t=index_es_Me(e);if(t&&index_es_lt(t))return oe(t)}function index_es_ts(e,t){var n;return(n=e?.att)==null?void 0:n.hasOwnProperty(t)}function index_es_Nn(e,t){var n,r;return(n=e?.att)!=null&&n[t]?Object.keys((r=e?.att)==null?void 0:r[t]):[]}function ns(e){return e?.map(t=>Object.keys(t))||[]}function index_es_Sn(e){return e?.map(t=>{var n;return(n=t.split("/"))==null?void 0:n[1]})||[]}function index_es_Un(e){return Buffer.from(JSON.stringify(e)).toString("base64")}function index_es_n(e){return JSON.parse(Buffer.from(e,"base64").toString("utf-8"))}function Y(e){if(!e)throw new Error("No recap provided, value is undefined");if(!e.att)throw new Error("No `att` property found");const t=Object.keys(e.att);if(!(t!=null&&t.length))throw new Error("No resources found in `att` property");t.forEach(n=>{const r=e.att[n];if(Array.isArray(r))throw new Error(`Resource must be an object: ${n}`);if(typeof r!="object")throw new Error(`Resource must be an object: ${n}`);if(!Object.keys(r).length)throw new Error(`Resource object is empty: ${n}`);Object.keys(r).forEach(o=>{const s=r[o];if(!Array.isArray(s))throw new Error(`Ability limits ${o} must be an array of objects, found: ${s}`);if(!s.length)throw new Error(`Value of ${o} is empty array, must be an array with objects`);s.forEach(i=>{if(typeof i!="object")throw new Error(`Ability limits (${o}) must be an array of objects, found: ${i}`)})})})}function index_es_Tn(e,t,n,r={}){return n?.sort((o,s)=>o.localeCompare(s)),{att:{[e]:index_es_ft(t,n,r)}}}function index_es_$n(e,t,n){var r;e.att[t]=at({},n);const o=(r=Object.keys(e.att))==null?void 0:r.sort((i,c)=>i.localeCompare(c)),s={att:{}};return o.reduce((i,c)=>(i.att[c]=e.att[c],i),s)}function index_es_ft(e,t,n={}){t=t?.sort((o,s)=>o.localeCompare(s));const r=t.map(o=>({[`${e}/${o}`]:[n]}));return Object.assign({},...r)}function index_es_De(e){return Y(e),`urn:recap:${index_es_Un(e).replace(/=/g,"")}`}function oe(e){const t=index_es_n(e.replace("urn:recap:",""));return Y(t),t}function rs(e,t,n){const r=index_es_Tn(e,t,n);return index_es_De(r)}function index_es_lt(e){return e&&e.includes("urn:recap:")}function os(e,t){const n=oe(e),r=oe(t),o=index_es_Rn(n,r);return index_es_De(o)}function index_es_Rn(e,t){Y(e),Y(t);const n=Object.keys(e.att).concat(Object.keys(t.att)).sort((o,s)=>o.localeCompare(s)),r={att:{}};return n.forEach(o=>{var s,i;Object.keys(((s=e.att)==null?void 0:s[o])||{}).concat(Object.keys(((i=t.att)==null?void 0:i[o])||{})).sort((c,u)=>c.localeCompare(u)).forEach(c=>{var u,a;r.att[o]=index_es_vn(at({},r.att[o]),{[c]:((u=e.att[o])==null?void 0:u[c])||((a=t.att[o])==null?void 0:a[c])})})}),r}function index_es_dt(e="",t){Y(t);const n="I further authorize the stated URI to perform the following actions on my behalf: ";if(e.includes(n))return e;const r=[];let o=0;Object.keys(t.att).forEach(c=>{const u=Object.keys(t.att[c]).map(f=>({ability:f.split("/")[0],action:f.split("/")[1]}));u.sort((f,d)=>f.action.localeCompare(d.action));const a={};u.forEach(f=>{a[f.ability]||(a[f.ability]=[]),a[f.ability].push(f.action)});const l=Object.keys(a).map(f=>(o++,`(${o}) '${f}': '${a[f].join("', '")}' for '${c}'.`));r.push(l.join(", ").replace(".,","."))});const s=r.join(" "),i=`${n}${s}`;return`${e?e+" ":""}${i}`}function ss(e){var t;const n=oe(e);Y(n);const r=(t=n.att)==null?void 0:t.eip155;return r?Object.keys(r).map(o=>o.split("/")[1]):[]}function is(e){const t=oe(e);Y(t);const n=[];return Object.values(t.att).forEach(r=>{Object.values(r).forEach(o=>{var s;(s=o?.[0])!=null&&s.chains&&n.push(o[0].chains)})}),[...new Set(n.flat())]}function index_es_Pn(e,t){if(!t)return e;const n=oe(t);return Y(n),index_es_dt(e,n)}function index_es_Me(e){if(!e)return;const t=e?.[e.length-1];return index_es_lt(t)?t:void 0}function index_es_ht(e){if(!Number.isSafeInteger(e)||e<0)throw new Error("positive integer expected, got "+e)}function index_es_Bn(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function F(e,...t){if(!index_es_Bn(e))throw new Error("Uint8Array expected");if(t.length>0&&!t.includes(e.length))throw new Error("Uint8Array expected of length "+t+", got length="+e.length)}function index_es_Ln(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function cs(e,t){F(e);const n=t.outputLen;if(e.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}function index_es_jn(e){if(typeof e!="boolean")throw new Error(`boolean expected, not ${e}`)}const se=e=>new Uint32Array(e.buffer,e.byteOffset,Math.floor(e.byteLength/4)),as=e=>new DataView(e.buffer,e.byteOffset,e.byteLength),us=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;if(!us)throw new Error("Non little-endian hardware is not supported");function fs(e){if(typeof e!="string")throw new Error("string expected");return new Uint8Array(new TextEncoder().encode(e))}function pt(e){if(typeof e=="string")e=fs(e);else if(index_es_Bn(e))e=index_es_gt(e);else throw new Error("Uint8Array expected, got "+typeof e);return e}function ls(e,t){if(t==null||typeof t!="object")throw new Error("options must be defined");return Object.assign(e,t)}function ds(e,t){if(e.length!==t.length)return!1;let n=0;for(let r=0;r<e.length;r++)n|=e[r]^t[r];return n===0}const hs=(e,t)=>{function n(r,...o){if(F(r),e.nonceLength!==void 0){const l=o[0];if(!l)throw new Error("nonce / iv required");e.varSizeNonce?F(l):F(l,e.nonceLength)}const s=e.tagLength;s&&o[1]!==void 0&&F(o[1]);const i=t(r,...o),c=(l,f)=>{if(f!==void 0){if(l!==2)throw new Error("cipher output not supported");F(f)}};let u=!1;return{encrypt(l,f){if(u)throw new Error("cannot encrypt() twice with same key + nonce");return u=!0,F(l),c(i.encrypt.length,f),i.encrypt(l,f)},decrypt(l,f){if(F(l),s&&l.length<s)throw new Error("invalid ciphertext length: smaller than tagLength="+s);return c(i.decrypt.length,f),i.decrypt(l,f)}}}return Object.assign(n,e),n};function index_es_Cn(e,t,n=!0){if(t===void 0)return new Uint8Array(e);if(t.length!==e)throw new Error("invalid output length, expected "+e+", got: "+t.length);if(n&&!ps(t))throw new Error("invalid output, must be aligned");return t}function index_es_kn(e,t,n,r){if(typeof e.setBigUint64=="function")return e.setBigUint64(t,n,r);const o=BigInt(32),s=BigInt(4294967295),i=Number(n>>o&s),c=Number(n&s),u=r?4:0,a=r?0:4;e.setUint32(t+u,i,r),e.setUint32(t+a,c,r)}function ps(e){return e.byteOffset%4===0}function index_es_gt(e){return Uint8Array.from(e)}function index_es_Ee(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}const Dn=e=>Uint8Array.from(e.split("").map(t=>t.charCodeAt(0))),gs=Dn("expand 16-byte k"),ys=Dn("expand 32-byte k"),ms=se(gs),bs=se(ys);function index_es_x(e,t){return e<<t|e>>>32-t}function index_es_yt(e){return e.byteOffset%4===0}const index_es_Ve=64,ws=16,index_es_Mn=2**32-1,index_es_Vn=new Uint32Array;function Es(e,t,n,r,o,s,i,c){const u=o.length,a=new Uint8Array(index_es_Ve),l=se(a),f=index_es_yt(o)&&index_es_yt(s),d=f?se(o):index_es_Vn,g=f?se(s):index_es_Vn;for(let y=0;y<u;i++){if(e(t,n,r,l,i,c),i>=index_es_Mn)throw new Error("arx: counter overflow");const h=Math.min(index_es_Ve,u-y);if(f&&h===index_es_Ve){const m=y/4;if(y%4!==0)throw new Error("arx: invalid block position");for(let L=0,b;L<ws;L++)b=m+L,g[b]=d[b]^l[L];y+=index_es_Ve;continue}for(let m=0,L;m<h;m++)L=y+m,s[L]=o[L]^a[m];y+=h}}function vs(e,t){const{allowShortKeys:n,extendNonceFn:r,counterLength:o,counterRight:s,rounds:i}=ls({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},t);if(typeof e!="function")throw new Error("core must be a function");return index_es_ht(o),index_es_ht(i),index_es_jn(s),index_es_jn(n),(c,u,a,l,f=0)=>{F(c),F(u),F(a);const d=a.length;if(l===void 0&&(l=new Uint8Array(d)),F(l),index_es_ht(f),f<0||f>=index_es_Mn)throw new Error("arx: counter overflow");if(l.length<d)throw new Error(`arx: output (${l.length}) is shorter than data (${d})`);const g=[];let y=c.length,h,m;if(y===32)g.push(h=index_es_gt(c)),m=bs;else if(y===16&&n)h=new Uint8Array(32),h.set(c),h.set(c,16),m=ms,g.push(h);else throw new Error(`arx: invalid 32-byte key, got length=${y}`);index_es_yt(u)||g.push(u=index_es_gt(u));const L=se(h);if(r){if(u.length!==24)throw new Error("arx: extended nonce must be 24 bytes");r(m,L,se(u.subarray(0,16)),L),u=u.subarray(16)}const b=16-o;if(b!==u.length)throw new Error(`arx: nonce must be ${b} or 16 bytes`);if(b!==12){const O=new Uint8Array(12);O.set(u,s?0:12-u.length),u=O,g.push(u)}const _=se(u);return Es(e,m,L,_,a,l,f,i),index_es_Ee(...g),l}}const index_es_M=(e,t)=>e[t++]&255|(e[t++]&255)<<8;class xs{constructor(t){this.blockLen=16,this.outputLen=16,this.buffer=new Uint8Array(16),this.r=new Uint16Array(10),this.h=new Uint16Array(10),this.pad=new Uint16Array(8),this.pos=0,this.finished=!1,t=pt(t),F(t,32);const n=index_es_M(t,0),r=index_es_M(t,2),o=index_es_M(t,4),s=index_es_M(t,6),i=index_es_M(t,8),c=index_es_M(t,10),u=index_es_M(t,12),a=index_es_M(t,14);this.r[0]=n&8191,this.r[1]=(n>>>13|r<<3)&8191,this.r[2]=(r>>>10|o<<6)&7939,this.r[3]=(o>>>7|s<<9)&8191,this.r[4]=(s>>>4|i<<12)&255,this.r[5]=i>>>1&8190,this.r[6]=(i>>>14|c<<2)&8191,this.r[7]=(c>>>11|u<<5)&8065,this.r[8]=(u>>>8|a<<8)&8191,this.r[9]=a>>>5&127;for(let l=0;l<8;l++)this.pad[l]=index_es_M(t,16+2*l)}process(t,n,r=!1){const o=r?0:2048,{h:s,r:i}=this,c=i[0],u=i[1],a=i[2],l=i[3],f=i[4],d=i[5],g=i[6],y=i[7],h=i[8],m=i[9],L=index_es_M(t,n+0),b=index_es_M(t,n+2),_=index_es_M(t,n+4),O=index_es_M(t,n+6),k=index_es_M(t,n+8),E=index_es_M(t,n+10),B=index_es_M(t,n+12),j=index_es_M(t,n+14);let v=s[0]+(L&8191),I=s[1]+((L>>>13|b<<3)&8191),w=s[2]+((b>>>10|_<<6)&8191),R=s[3]+((_>>>7|O<<9)&8191),A=s[4]+((O>>>4|k<<12)&8191),T=s[5]+(k>>>1&8191),N=s[6]+((k>>>14|E<<2)&8191),S=s[7]+((E>>>11|B<<5)&8191),U=s[8]+((B>>>8|j<<8)&8191),$=s[9]+(j>>>5|o),p=0,C=p+v*c+I*(5*m)+w*(5*h)+R*(5*y)+A*(5*g);p=C>>>13,C&=8191,C+=T*(5*d)+N*(5*f)+S*(5*l)+U*(5*a)+$*(5*u),p+=C>>>13,C&=8191;let D=p+v*u+I*c+w*(5*m)+R*(5*h)+A*(5*y);p=D>>>13,D&=8191,D+=T*(5*g)+N*(5*d)+S*(5*f)+U*(5*l)+$*(5*a),p+=D>>>13,D&=8191;let P=p+v*a+I*u+w*c+R*(5*m)+A*(5*h);p=P>>>13,P&=8191,P+=T*(5*y)+N*(5*g)+S*(5*d)+U*(5*f)+$*(5*l),p+=P>>>13,P&=8191;let G=p+v*l+I*a+w*u+R*c+A*(5*m);p=G>>>13,G&=8191,G+=T*(5*h)+N*(5*y)+S*(5*g)+U*(5*d)+$*(5*f),p+=G>>>13,G&=8191;let X=p+v*f+I*l+w*a+R*u+A*c;p=X>>>13,X&=8191,X+=T*(5*m)+N*(5*h)+S*(5*y)+U*(5*g)+$*(5*d),p+=X>>>13,X&=8191;let Z=p+v*d+I*f+w*l+R*a+A*u;p=Z>>>13,Z&=8191,Z+=T*c+N*(5*m)+S*(5*h)+U*(5*y)+$*(5*g),p+=Z>>>13,Z&=8191;let he=p+v*g+I*d+w*f+R*l+A*a;p=he>>>13,he&=8191,he+=T*u+N*c+S*(5*m)+U*(5*h)+$*(5*y),p+=he>>>13,he&=8191;let pe=p+v*y+I*g+w*d+R*f+A*l;p=pe>>>13,pe&=8191,pe+=T*a+N*u+S*c+U*(5*m)+$*(5*h),p+=pe>>>13,pe&=8191;let ge=p+v*h+I*y+w*g+R*d+A*f;p=ge>>>13,ge&=8191,ge+=T*l+N*a+S*u+U*c+$*(5*m),p+=ge>>>13,ge&=8191;let ye=p+v*m+I*h+w*y+R*g+A*d;p=ye>>>13,ye&=8191,ye+=T*f+N*l+S*a+U*u+$*c,p+=ye>>>13,ye&=8191,p=(p<<2)+p|0,p=p+C|0,C=p&8191,p=p>>>13,D+=p,s[0]=C,s[1]=D,s[2]=P,s[3]=G,s[4]=X,s[5]=Z,s[6]=he,s[7]=pe,s[8]=ge,s[9]=ye}finalize(){const{h:t,pad:n}=this,r=new Uint16Array(10);let o=t[1]>>>13;t[1]&=8191;for(let c=2;c<10;c++)t[c]+=o,o=t[c]>>>13,t[c]&=8191;t[0]+=o*5,o=t[0]>>>13,t[0]&=8191,t[1]+=o,o=t[1]>>>13,t[1]&=8191,t[2]+=o,r[0]=t[0]+5,o=r[0]>>>13,r[0]&=8191;for(let c=1;c<10;c++)r[c]=t[c]+o,o=r[c]>>>13,r[c]&=8191;r[9]-=8192;let s=(o^1)-1;for(let c=0;c<10;c++)r[c]&=s;s=~s;for(let c=0;c<10;c++)t[c]=t[c]&s|r[c];t[0]=(t[0]|t[1]<<13)&65535,t[1]=(t[1]>>>3|t[2]<<10)&65535,t[2]=(t[2]>>>6|t[3]<<7)&65535,t[3]=(t[3]>>>9|t[4]<<4)&65535,t[4]=(t[4]>>>12|t[5]<<1|t[6]<<14)&65535,t[5]=(t[6]>>>2|t[7]<<11)&65535,t[6]=(t[7]>>>5|t[8]<<8)&65535,t[7]=(t[8]>>>8|t[9]<<5)&65535;let i=t[0]+n[0];t[0]=i&65535;for(let c=1;c<8;c++)i=(t[c]+n[c]|0)+(i>>>16)|0,t[c]=i&65535;index_es_Ee(r)}update(t){index_es_Ln(this);const{buffer:n,blockLen:r}=this;t=pt(t);const o=t.length;for(let s=0;s<o;){const i=Math.min(r-this.pos,o-s);if(i===r){for(;r<=o-s;s+=r)this.process(t,s);continue}n.set(t.subarray(s,s+i),this.pos),this.pos+=i,s+=i,this.pos===r&&(this.process(n,0,!1),this.pos=0)}return this}destroy(){index_es_Ee(this.h,this.r,this.buffer,this.pad)}digestInto(t){index_es_Ln(this),cs(t,this),this.finished=!0;const{buffer:n,h:r}=this;let{pos:o}=this;if(o){for(n[o++]=1;o<16;o++)n[o]=0;this.process(n,0,!0)}this.finalize();let s=0;for(let i=0;i<8;i++)t[s++]=r[i]>>>0,t[s++]=r[i]>>>8;return t}digest(){const{buffer:t,outputLen:n}=this;this.digestInto(t);const r=t.slice(0,n);return this.destroy(),r}}function Is(e){const t=(r,o)=>e(o).update(pt(r)).digest(),n=e(new Uint8Array(32));return t.outputLen=n.outputLen,t.blockLen=n.blockLen,t.create=r=>e(r),t}const Os=Is(e=>new xs(e));function As(e,t,n,r,o,s=20){let i=e[0],c=e[1],u=e[2],a=e[3],l=t[0],f=t[1],d=t[2],g=t[3],y=t[4],h=t[5],m=t[6],L=t[7],b=o,_=n[0],O=n[1],k=n[2],E=i,B=c,j=u,v=a,I=l,w=f,R=d,A=g,T=y,N=h,S=m,U=L,$=b,p=_,C=O,D=k;for(let G=0;G<s;G+=2)E=E+I|0,$=index_es_x($^E,16),T=T+$|0,I=index_es_x(I^T,12),E=E+I|0,$=index_es_x($^E,8),T=T+$|0,I=index_es_x(I^T,7),B=B+w|0,p=index_es_x(p^B,16),N=N+p|0,w=index_es_x(w^N,12),B=B+w|0,p=index_es_x(p^B,8),N=N+p|0,w=index_es_x(w^N,7),j=j+R|0,C=index_es_x(C^j,16),S=S+C|0,R=index_es_x(R^S,12),j=j+R|0,C=index_es_x(C^j,8),S=S+C|0,R=index_es_x(R^S,7),v=v+A|0,D=index_es_x(D^v,16),U=U+D|0,A=index_es_x(A^U,12),v=v+A|0,D=index_es_x(D^v,8),U=U+D|0,A=index_es_x(A^U,7),E=E+w|0,D=index_es_x(D^E,16),S=S+D|0,w=index_es_x(w^S,12),E=E+w|0,D=index_es_x(D^E,8),S=S+D|0,w=index_es_x(w^S,7),B=B+R|0,$=index_es_x($^B,16),U=U+$|0,R=index_es_x(R^U,12),B=B+R|0,$=index_es_x($^B,8),U=U+$|0,R=index_es_x(R^U,7),j=j+A|0,p=index_es_x(p^j,16),T=T+p|0,A=index_es_x(A^T,12),j=j+A|0,p=index_es_x(p^j,8),T=T+p|0,A=index_es_x(A^T,7),v=v+I|0,C=index_es_x(C^v,16),N=N+C|0,I=index_es_x(I^N,12),v=v+I|0,C=index_es_x(C^v,8),N=N+C|0,I=index_es_x(I^N,7);let P=0;r[P++]=i+E|0,r[P++]=c+B|0,r[P++]=u+j|0,r[P++]=a+v|0,r[P++]=l+I|0,r[P++]=f+w|0,r[P++]=d+R|0,r[P++]=g+A|0,r[P++]=y+T|0,r[P++]=h+N|0,r[P++]=m+S|0,r[P++]=L+U|0,r[P++]=b+$|0,r[P++]=_+p|0,r[P++]=O+C|0,r[P++]=k+D|0}const Ns=vs(As,{counterRight:!1,counterLength:4,allowShortKeys:!1}),Ss=new Uint8Array(16),index_es_Hn=(e,t)=>{e.update(t);const n=t.length%16;n&&e.update(Ss.subarray(n))},Us=new Uint8Array(32);function index_es_Kn(e,t,n,r,o){const s=e(t,n,Us),i=Os.create(s);o&&index_es_Hn(i,o),index_es_Hn(i,r);const c=new Uint8Array(16),u=as(c);index_es_kn(u,0,BigInt(o?o.length:0),!0),index_es_kn(u,8,BigInt(r.length),!0),i.update(c);const a=i.digest();return index_es_Ee(s,c),a}const _s=e=>(t,n,r)=>({encrypt(s,i){const c=s.length;i=index_es_Cn(c+16,i,!1),i.set(s);const u=i.subarray(0,-16);e(t,n,u,u,1);const a=index_es_Kn(e,t,n,u,r);return i.set(a,c),index_es_Ee(a),i},decrypt(s,i){i=index_es_Cn(s.length-16,i,!1);const c=s.subarray(0,-16),u=s.subarray(-16),a=index_es_Kn(e,t,n,c,r);if(!ds(u,a))throw new Error("invalid tag");return i.set(s.subarray(0,-16)),e(t,n,i,i,1),index_es_Ee(a),i}}),index_es_Fn=hs({blockSize:64,nonceLength:12,tagLength:16},_s(Ns));class index_es_qn extends index_es_it{constructor(t,n){super(),this.finished=!1,this.destroyed=!1,ot(t);const r=index_es_we(n);if(this.iHash=t.create(),typeof this.iHash.update!="function")throw new Error("Expected instance of class which extends utils.Hash");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;const o=this.blockLen,s=new Uint8Array(o);s.set(r.length>o?t.create().update(r).digest():r);for(let i=0;i<s.length;i++)s[i]^=54;this.iHash.update(s),this.oHash=t.create();for(let i=0;i<s.length;i++)s[i]^=106;this.oHash.update(s),s.fill(0)}update(t){return index_es_me(this),this.iHash.update(t),this}digestInto(t){index_es_me(this),index_es_je(t,this.outputLen),this.finished=!0,this.iHash.digestInto(t),this.oHash.update(t),this.oHash.digestInto(t),this.destroy()}digest(){const t=new Uint8Array(this.oHash.outputLen);return this.digestInto(t),t}_cloneInto(t){t||(t=Object.create(Object.getPrototypeOf(this),{}));const{oHash:n,iHash:r,finished:o,destroyed:s,blockLen:i,outputLen:c}=this;return t=t,t.finished=o,t.destroyed=s,t.blockLen=i,t.outputLen=c,t.oHash=n._cloneInto(t.oHash),t.iHash=r._cloneInto(t.iHash),t}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}}const mt=(e,t,n)=>new index_es_qn(e,t).update(n).digest();mt.create=(e,t)=>new index_es_qn(e,t);function Ts(e,t,n){return ot(e),n===void 0&&(n=new Uint8Array(e.outputLen)),mt(e,index_es_we(n),index_es_we(t))}const index_es_bt=new Uint8Array([0]),index_es_Gn=new Uint8Array;function $s(e,t,n,r=32){if(ot(e),index_es_Ne(r),r>255*e.outputLen)throw new Error("Length should be <= 255*HashLen");const o=Math.ceil(r/e.outputLen);n===void 0&&(n=index_es_Gn);const s=new Uint8Array(o*e.outputLen),i=mt.create(e,t),c=i._cloneInto(),u=new Uint8Array(i.outputLen);for(let a=0;a<o;a++)index_es_bt[0]=a+1,c.update(a===0?index_es_Gn:u).update(n).update(index_es_bt).digestInto(u),s.set(u,e.outputLen*a),i._cloneInto(c);return i.destroy(),c.destroy(),u.fill(0),index_es_bt.fill(0),s.slice(0,r)}const Rs=(e,t,n,r,o)=>$s(e,Ts(e,t,n),r,o);function Ps(e,t,n,r){if(typeof e.setBigUint64=="function")return e.setBigUint64(t,n,r);const o=BigInt(32),s=BigInt(4294967295),i=Number(n>>o&s),c=Number(n&s),u=r?4:0,a=r?0:4;e.setUint32(t+u,i,r),e.setUint32(t+a,c,r)}function Bs(e,t,n){return e&t^~e&n}function Ls(e,t,n){return e&t^e&n^t&n}class js extends index_es_it{constructor(t,n,r,o){super(),this.blockLen=t,this.outputLen=n,this.padOffset=r,this.isLE=o,this.finished=!1,this.length=0,this.pos=0,this.destroyed=!1,this.buffer=new Uint8Array(t),this.view=st(this.buffer)}update(t){index_es_me(this);const{view:n,buffer:r,blockLen:o}=this;t=index_es_we(t);const s=t.length;for(let i=0;i<s;){const c=Math.min(o-this.pos,s-i);if(c===o){const u=st(t);for(;o<=s-i;i+=o)this.process(u,i);continue}r.set(t.subarray(i,i+c),this.pos),this.pos+=c,i+=c,this.pos===o&&(this.process(n,0),this.pos=0)}return this.length+=t.length,this.roundClean(),this}digestInto(t){index_es_me(this),index_es_sn(t,this),this.finished=!0;const{buffer:n,view:r,blockLen:o,isLE:s}=this;let{pos:i}=this;n[i++]=128,this.buffer.subarray(i).fill(0),this.padOffset>o-i&&(this.process(r,0),i=0);for(let f=i;f<o;f++)n[f]=0;Ps(r,o-8,BigInt(this.length*8),s),this.process(r,0);const c=st(t),u=this.outputLen;if(u%4)throw new Error("_sha2: outputLen should be aligned to 32bit");const a=u/4,l=this.get();if(a>l.length)throw new Error("_sha2: outputLen bigger than state");for(let f=0;f<a;f++)c.setUint32(4*f,l[f],s)}digest(){const{buffer:t,outputLen:n}=this;this.digestInto(t);const r=t.slice(0,n);return this.destroy(),r}_cloneInto(t){t||(t=new this.constructor),t.set(...this.get());const{blockLen:n,buffer:r,length:o,finished:s,destroyed:i,pos:c}=this;return t.length=o,t.pos=c,t.finished=s,t.destroyed=i,o%n&&t.buffer.set(r),t}}const Cs=new Uint32Array([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),ie=new Uint32Array([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]),ce=new Uint32Array(64);class ks extends js{constructor(){super(64,32,8,!1),this.A=ie[0]|0,this.B=ie[1]|0,this.C=ie[2]|0,this.D=ie[3]|0,this.E=ie[4]|0,this.F=ie[5]|0,this.G=ie[6]|0,this.H=ie[7]|0}get(){const{A:t,B:n,C:r,D:o,E:s,F:i,G:c,H:u}=this;return[t,n,r,o,s,i,c,u]}set(t,n,r,o,s,i,c,u){this.A=t|0,this.B=n|0,this.C=r|0,this.D=o|0,this.E=s|0,this.F=i|0,this.G=c|0,this.H=u|0}process(t,n){for(let f=0;f<16;f++,n+=4)ce[f]=t.getUint32(n,!1);for(let f=16;f<64;f++){const d=ce[f-15],g=ce[f-2],y=index_es_J(d,7)^index_es_J(d,18)^d>>>3,h=index_es_J(g,17)^index_es_J(g,19)^g>>>10;ce[f]=h+ce[f-7]+y+ce[f-16]|0}let{A:r,B:o,C:s,D:i,E:c,F:u,G:a,H:l}=this;for(let f=0;f<64;f++){const d=index_es_J(c,6)^index_es_J(c,11)^index_es_J(c,25),g=l+d+Bs(c,u,a)+Cs[f]+ce[f]|0,h=(index_es_J(r,2)^index_es_J(r,13)^index_es_J(r,22))+Ls(r,o,s)|0;l=a,a=u,u=c,c=i+g|0,i=s,s=o,o=r,r=g+h|0}r=r+this.A|0,o=o+this.B|0,s=s+this.C|0,i=i+this.D|0,c=c+this.E|0,u=u+this.F|0,a=a+this.G|0,l=l+this.H|0,this.set(r,o,s,i,c,u,a,l)}roundClean(){ce.fill(0)}destroy(){this.set(0,0,0,0,0,0,0,0),this.buffer.fill(0)}}const index_es_He=fn(()=>new ks);/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */const index_es_Wn=BigInt(0);function index_es_wt(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function index_es_zn(e){if(!index_es_wt(e))throw new Error("Uint8Array expected")}const Ds=Array.from({length:256},(e,t)=>t.toString(16).padStart(2,"0"));function Ms(e){index_es_zn(e);let t="";for(let n=0;n<e.length;n++)t+=Ds[e[n]];return t}function Vs(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);return e===""?index_es_Wn:BigInt("0x"+e)}const ee={_0:48,_9:57,A:65,F:70,a:97,f:102};function index_es_Jn(e){if(e>=ee._0&&e<=ee._9)return e-ee._0;if(e>=ee.A&&e<=ee.F)return e-(ee.A-10);if(e>=ee.a&&e<=ee.f)return e-(ee.a-10)}function index_es_Yn(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);const t=e.length,n=t/2;if(t%2)throw new Error("hex string expected, got unpadded hex of length "+t);const r=new Uint8Array(n);for(let o=0,s=0;o<n;o++,s+=2){const i=index_es_Jn(e.charCodeAt(s)),c=index_es_Jn(e.charCodeAt(s+1));if(i===void 0||c===void 0){const u=e[s]+e[s+1];throw new Error('hex string expected, got non-hex character "'+u+'" at index '+s)}r[o]=i*16+c}return r}function index_es_Xn(e){return index_es_zn(e),Vs(Ms(Uint8Array.from(e).reverse()))}function Hs(e,t){return index_es_Yn(e.toString(16).padStart(t*2,"0"))}function Ks(e,t){return Hs(e,t).reverse()}function index_es_Zn(e,t,n){let r;if(typeof t=="string")try{r=index_es_Yn(t)}catch(s){throw new Error(e+" must be hex string or Uint8Array, cause: "+s)}else if(index_es_wt(t))r=Uint8Array.from(t);else throw new Error(e+" must be hex string or Uint8Array");const o=r.length;if(typeof n=="number"&&o!==n)throw new Error(e+" of length "+n+" expected, got "+o);return r}const index_es_Et=e=>typeof e=="bigint"&&index_es_Wn<=e;function Fs(e,t,n){return index_es_Et(e)&&index_es_Et(t)&&index_es_Et(n)&&t<=e&&e<n}function index_es_Qn(e,t,n,r){if(!Fs(t,n,r))throw new Error("expected valid "+e+": "+n+" <= n < "+r+", got "+t)}const qs={bigint:e=>typeof e=="bigint",function:e=>typeof e=="function",boolean:e=>typeof e=="boolean",string:e=>typeof e=="string",stringOrUint8Array:e=>typeof e=="string"||index_es_wt(e),isSafeInteger:e=>Number.isSafeInteger(e),array:e=>Array.isArray(e),field:(e,t)=>t.Fp.isValid(e),hash:e=>typeof e=="function"&&Number.isSafeInteger(e.outputLen)};function Gs(e,t,n={}){const r=(o,s,i)=>{const c=qs[s];if(typeof c!="function")throw new Error("invalid validator function");const u=e[o];if(!(i&&u===void 0)&&!c(u,e))throw new Error("param "+String(o)+" is invalid. Expected "+s+", got "+u)};for(const[o,s]of Object.entries(t))r(o,s,!1);for(const[o,s]of Object.entries(n))r(o,s,!0);return e}const index_es_ve=BigInt(0),index_es_Ke=BigInt(1);function index_es_er(e,t){const n=e%t;return n>=index_es_ve?n:t+n}function Ws(e,t,n){if(t<index_es_ve)throw new Error("invalid exponent, negatives unsupported");if(n<=index_es_ve)throw new Error("invalid modulus");if(n===index_es_Ke)return index_es_ve;let r=index_es_Ke;for(;t>index_es_ve;)t&index_es_Ke&&(r=r*e%n),e=e*e%n,t>>=index_es_Ke;return r}function z(e,t,n){let r=e;for(;t-- >index_es_ve;)r*=r,r%=n;return r}BigInt(0),BigInt(1),BigInt(0),BigInt(1),BigInt(2),BigInt(8);const index_es_xe=BigInt(0),index_es_vt=BigInt(1);function zs(e){return Gs(e,{a:"bigint"},{montgomeryBits:"isSafeInteger",nByteLength:"isSafeInteger",adjustScalarBytes:"function",domain:"function",powPminus2:"function",Gu:"bigint"}),Object.freeze({...e})}function Js(e){const t=zs(e),{P:n}=t,r=b=>index_es_er(b,n),o=t.montgomeryBits,s=Math.ceil(o/8),i=t.nByteLength,c=t.adjustScalarBytes||(b=>b),u=t.powPminus2||(b=>Ws(b,n-BigInt(2),n));function a(b,_,O){const k=r(b*(_-O));return _=r(_-k),O=r(O+k),[_,O]}const l=(t.a-BigInt(2))/BigInt(4);function f(b,_){index_es_Qn("u",b,index_es_xe,n),index_es_Qn("scalar",_,index_es_xe,n);const O=_,k=b;let E=index_es_vt,B=index_es_xe,j=b,v=index_es_vt,I=index_es_xe,w;for(let A=BigInt(o-1);A>=index_es_xe;A--){const T=O>>A&index_es_vt;I^=T,w=a(I,E,j),E=w[0],j=w[1],w=a(I,B,v),B=w[0],v=w[1],I=T;const N=E+B,S=r(N*N),U=E-B,$=r(U*U),p=S-$,C=j+v,D=j-v,P=r(D*N),G=r(C*U),X=P+G,Z=P-G;j=r(X*X),v=r(k*r(Z*Z)),E=r(S*$),B=r(p*(S+r(l*p)))}w=a(I,E,j),E=w[0],j=w[1],w=a(I,B,v),B=w[0],v=w[1];const R=u(B);return r(E*R)}function d(b){return Ks(r(b),s)}function g(b){const _=index_es_Zn("u coordinate",b,s);return i===32&&(_[31]&=127),index_es_Xn(_)}function y(b){const _=index_es_Zn("scalar",b),O=_.length;if(O!==s&&O!==i){let k=""+s+" or "+i;throw new Error("invalid scalar, expected "+k+" bytes, got "+O)}return index_es_Xn(c(_))}function h(b,_){const O=g(_),k=y(b),E=f(O,k);if(E===index_es_xe)throw new Error("invalid private or public key received");return d(E)}const m=d(t.Gu);function L(b){return h(b,m)}return{scalarMult:h,scalarMultBase:L,getSharedSecret:(b,_)=>h(b,_),getPublicKey:b=>L(b),utils:{randomPrivateKey:()=>t.randomBytes(t.nByteLength)},GuBytes:m}}const index_es_xt=BigInt("57896044618658097711785492504343953926634992332820282019728792003956564819949");BigInt(0);const Ys=BigInt(1),index_es_tr=BigInt(2),Xs=BigInt(3),Zs=BigInt(5);BigInt(8);function Qs(e){const t=BigInt(10),n=BigInt(20),r=BigInt(40),o=BigInt(80),s=index_es_xt,c=e*e%s*e%s,u=z(c,index_es_tr,s)*c%s,a=z(u,Ys,s)*e%s,l=z(a,Zs,s)*a%s,f=z(l,t,s)*l%s,d=z(f,n,s)*f%s,g=z(d,r,s)*d%s,y=z(g,o,s)*g%s,h=z(y,o,s)*g%s,m=z(h,t,s)*l%s;return{pow_p_5_8:z(m,index_es_tr,s)*e%s,b2:c}}function ei(e){return e[0]&=248,e[31]&=127,e[31]|=64,e}const index_es_It=Js({P:index_es_xt,a:BigInt(486662),montgomeryBits:255,nByteLength:32,Gu:BigInt(9),powPminus2:e=>{const t=index_es_xt,{pow_p_5_8:n,b2:r}=Qs(e);return index_es_er(z(n,Xs,t)*r,t)},adjustScalarBytes:ei,randomBytes:index_es_Se}),index_es_Ot="base10",V="base16",At="base64pad",ti="base64url",index_es_Ie="utf8",index_es_Nt=0,index_es_Oe=1,index_es_e=2,ni=0,index_es_nr=1,index_es_Te=12,index_es_St=32;function ri(){const e=index_es_It.utils.randomPrivateKey(),t=index_es_It.getPublicKey(e);return{privateKey:to_string_toString(e,V),publicKey:to_string_toString(t,V)}}function oi(){const e=index_es_Se(index_es_St);return to_string_toString(e,V)}function si(e,t){const n=index_es_It.getSharedSecret(fromString(e,V),fromString(t,V)),r=Rs(index_es_He,n,void 0,void 0,index_es_St);return to_string_toString(r,V)}function ii(e){const t=index_es_He(fromString(e,V));return to_string_toString(t,V)}function ci(e){const t=index_es_He(fromString(e,index_es_Ie));return to_string_toString(t,V)}function index_es_Ut(e){return fromString(`${e}`,index_es_Ot)}function index_es_fe(e){return Number(to_string_toString(e,index_es_Ot))}function ai(e){const t=index_es_Ut(typeof e.type<"u"?e.type:index_es_Nt);if(index_es_fe(t)===index_es_Oe&&typeof e.senderPublicKey>"u")throw new Error("Missing sender public key for type 1 envelope");const n=typeof e.senderPublicKey<"u"?fromString(e.senderPublicKey,V):void 0,r=typeof e.iv<"u"?fromString(e.iv,V):index_es_Se(index_es_Te),o=fromString(e.symKey,V),s=index_es_Fn(o,r).encrypt(fromString(e.message,index_es_Ie));return index_es_t({type:t,sealed:s,iv:r,senderPublicKey:n,encoding:e.encoding})}function ui(e){const t=fromString(e.symKey,V),{sealed:n,iv:r}=index_es_Fe(e),o=index_es_Fn(t,r).decrypt(n);if(o===null)throw new Error("Failed to decrypt");return to_string_toString(o,index_es_Ie)}function fi(e,t){const n=index_es_Ut(index_es_e),r=index_es_Se(index_es_Te),o=fromString(e,index_es_Ie);return index_es_t({type:n,sealed:o,iv:r,encoding:t})}function li(e,t){const{sealed:n}=index_es_Fe({encoded:e,encoding:t});return to_string_toString(n,index_es_Ie)}function index_es_t(e){const{encoding:t=At}=e;if(index_es_fe(e.type)===index_es_e)return to_string_toString(concat([e.type,e.sealed]),t);if(index_es_fe(e.type)===index_es_Oe){if(typeof e.senderPublicKey>"u")throw new Error("Missing sender public key for type 1 envelope");return to_string_toString(concat([e.type,e.senderPublicKey,e.iv,e.sealed]),t)}return to_string_toString(concat([e.type,e.iv,e.sealed]),t)}function index_es_Fe(e){const{encoded:t,encoding:n=At}=e,r=fromString(t,n),o=r.slice(ni,index_es_nr),s=index_es_nr;if(index_es_fe(o)===index_es_Oe){const a=s+index_es_St,l=a+index_es_Te,f=r.slice(s,a),d=r.slice(a,l),g=r.slice(l);return{type:o,sealed:g,iv:d,senderPublicKey:f}}if(index_es_fe(o)===index_es_e){const a=r.slice(s),l=index_es_Se(index_es_Te);return{type:o,sealed:a,iv:l}}const i=s+index_es_Te,c=r.slice(s,i),u=r.slice(i);return{type:o,sealed:u,iv:c}}function di(e,t){const n=index_es_Fe({encoded:e,encoding:t?.encoding});return index_es_rr({type:index_es_fe(n.type),senderPublicKey:typeof n.senderPublicKey<"u"?to_string_toString(n.senderPublicKey,V):void 0,receiverPublicKey:t?.receiverPublicKey})}function index_es_rr(e){const t=e?.type||index_es_Nt;if(t===index_es_Oe){if(typeof e?.senderPublicKey>"u")throw new Error("missing sender public key");if(typeof e?.receiverPublicKey>"u")throw new Error("missing receiver public key")}return{type:t,senderPublicKey:e?.senderPublicKey,receiverPublicKey:e?.receiverPublicKey}}function hi(e){return e.type===index_es_Oe&&typeof e.senderPublicKey=="string"&&typeof e.receiverPublicKey=="string"}function pi(e){return e.type===index_es_e}function index_es_or(e){return new elliptic.ec("p256").keyFromPublic({x:Buffer.from(e.x,"base64").toString("hex"),y:Buffer.from(e.y,"base64").toString("hex")},"hex")}function gi(e){let t=e.replace(/-/g,"+").replace(/_/g,"/");const n=t.length%4;return n>0&&(t+="=".repeat(4-n)),t}function yi(e){return Buffer.from(gi(e),"base64")}function mi(e,t){const[n,r,o]=e.split("."),s=yi(o);if(s.length!==64)throw new Error("Invalid signature length");const i=s.slice(0,32).toString("hex"),c=s.slice(32,64).toString("hex"),u=`${n}.${r}`,a=index_es_He(u),l=index_es_or(t),f=to_string_toString(a,V);if(!l.verify(f,{r:i,s:c}))throw new Error("Invalid signature");return sn(e).payload}const index_es_sr="irn";function bi(e){return e?.relay||{protocol:index_es_sr}}function wi(e){const t=C[e];if(typeof t>"u")throw new Error(`Relay Protocol not supported: ${e}`);return t}function index_es_ir(e,t="-"){const n={},r="relay"+t;return Object.keys(e).forEach(o=>{if(o.startsWith(r)){const s=o.replace(r,""),i=e[o];n[s]=i}}),n}function Ei(e){if(!e.includes("wc:")){const a=index_es_rt(e);a!=null&&a.includes("wc:")&&(e=a)}e=e.includes("wc://")?e.replace("wc://",""):e,e=e.includes("wc:")?e.replace("wc:",""):e;const t=e.indexOf(":"),n=e.indexOf("?")!==-1?e.indexOf("?"):void 0,r=e.substring(0,t),o=e.substring(t+1,n).split("@"),s=typeof n<"u"?e.substring(n):"",i=new URLSearchParams(s),c={};i.forEach((a,l)=>{c[l]=a});const u=typeof c.methods=="string"?c.methods.split(","):void 0;return{protocol:r,topic:index_es_cr(o[0]),version:parseInt(o[1],10),symKey:c.symKey,relay:index_es_ir(c),methods:u,expiryTimestamp:c.expiryTimestamp?parseInt(c.expiryTimestamp,10):void 0}}function index_es_cr(e){return e.startsWith("//")?e.substring(2):e}function index_es_ar(e,t="-"){const n="relay",r={};return Object.keys(e).forEach(o=>{const s=o,i=n+t+s;e[s]&&(r[i]=e[s])}),r}function vi(e){const t=new URLSearchParams,n=index_es_ar(e.relay);Object.keys(n).sort().forEach(o=>{t.set(o,n[o])}),t.set("symKey",e.symKey),e.expiryTimestamp&&t.set("expiryTimestamp",e.expiryTimestamp.toString()),e.methods&&t.set("methods",e.methods.join(","));const r=t.toString();return`${e.protocol}:${e.topic}@${e.version}?${r}`}function xi(e,t,n){return`${e}?wc_ev=${n}&topic=${t}`}var Ii=Object.defineProperty,Oi=Object.defineProperties,Ai=Object.getOwnPropertyDescriptors,index_es_ur=Object.getOwnPropertySymbols,Ni=Object.prototype.hasOwnProperty,Si=Object.prototype.propertyIsEnumerable,index_es_fr=(e,t,n)=>t in e?Ii(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,Ui=(e,t)=>{for(var n in t||(t={}))Ni.call(t,n)&&index_es_fr(e,n,t[n]);if(index_es_ur)for(var n of index_es_ur(t))Si.call(t,n)&&index_es_fr(e,n,t[n]);return e},_i=(e,t)=>Oi(e,Ai(t));function index_es_le(e){const t=[];return e.forEach(n=>{const[r,o]=n.split(":");t.push(`${r}:${o}`)}),t}function index_es_lr(e){const t=[];return Object.values(e).forEach(n=>{t.push(...index_es_le(n.accounts))}),t}function index_es_dr(e,t){const n=[];return Object.values(e).forEach(r=>{index_es_le(r.accounts).includes(t)&&n.push(...r.methods)}),n}function index_es_hr(e,t){const n=[];return Object.values(e).forEach(r=>{index_es_le(r.accounts).includes(t)&&n.push(...r.events)}),n}function Ti(e,t){const n=index_es_Or(e,t);if(n)throw new Error(n.message);const r={};for(const[o,s]of Object.entries(e))r[o]={methods:s.methods,events:s.events,chains:s.accounts.map(i=>`${i.split(":")[0]}:${i.split(":")[1]}`)};return r}function $i(e){const{proposal:{requiredNamespaces:t,optionalNamespaces:n={}},supportedNamespaces:r}=e,o=index_es_$t(t),s=index_es_$t(n),i={};Object.keys(r).forEach(a=>{const l=r[a].chains,f=r[a].methods,d=r[a].events,g=r[a].accounts;l.forEach(y=>{if(!g.some(h=>h.includes(y)))throw new Error(`No accounts provided for chain ${y} in namespace ${a}`)}),i[a]={chains:l,methods:f,events:d,accounts:g}});const c=index_es_Nr(t,i,"approve()");if(c)throw new Error(c.message);const u={};return!Object.keys(t).length&&!Object.keys(n).length?i:(Object.keys(o).forEach(a=>{const l=r[a].chains.filter(y=>{var h,m;return(m=(h=o[a])==null?void 0:h.chains)==null?void 0:m.includes(y)}),f=r[a].methods.filter(y=>{var h,m;return(m=(h=o[a])==null?void 0:h.methods)==null?void 0:m.includes(y)}),d=r[a].events.filter(y=>{var h,m;return(m=(h=o[a])==null?void 0:h.events)==null?void 0:m.includes(y)}),g=l.map(y=>r[a].accounts.filter(h=>h.includes(`${y}:`))).flat();u[a]={chains:l,methods:f,events:d,accounts:g}}),Object.keys(s).forEach(a=>{var l,f,d,g,y,h;if(!r[a])return;const m=(f=(l=s[a])==null?void 0:l.chains)==null?void 0:f.filter(O=>r[a].chains.includes(O)),L=r[a].methods.filter(O=>{var k,E;return(E=(k=s[a])==null?void 0:k.methods)==null?void 0:E.includes(O)}),b=r[a].events.filter(O=>{var k,E;return(E=(k=s[a])==null?void 0:k.events)==null?void 0:E.includes(O)}),_=m?.map(O=>r[a].accounts.filter(k=>k.includes(`${O}:`))).flat();u[a]={chains:index_es_Q((d=u[a])==null?void 0:d.chains,m),methods:index_es_Q((g=u[a])==null?void 0:g.methods,L),events:index_es_Q((y=u[a])==null?void 0:y.events,b),accounts:index_es_Q((h=u[a])==null?void 0:h.accounts,_)}}),u)}function index_es_Tt(e){return e.includes(":")}function index_es_pr(e){return index_es_Tt(e)?e.split(":")[0]:e}function index_es_$t(e){var t,n,r;const o={};if(!index_es_qe(e))return o;for(const[s,i]of Object.entries(e)){const c=index_es_Tt(s)?[s]:i.chains,u=i.methods||[],a=i.events||[],l=index_es_pr(s);o[l]=_i(Ui({},o[l]),{chains:index_es_Q(c,(t=o[l])==null?void 0:t.chains),methods:index_es_Q(u,(n=o[l])==null?void 0:n.methods),events:index_es_Q(a,(r=o[l])==null?void 0:r.events)})}return o}function index_es_gr(e){const t={};return e?.forEach(n=>{var r;const[o,s]=n.split(":");t[o]||(t[o]={accounts:[],chains:[],events:[],methods:[]}),t[o].accounts.push(n),(r=t[o].chains)==null||r.push(`${o}:${s}`)}),t}function Ri(e,t){t=t.map(r=>r.replace("did:pkh:",""));const n=index_es_gr(t);for(const[r,o]of Object.entries(n))o.methods?o.methods=index_es_Q(o.methods,e):o.methods=e,o.events=["chainChanged","accountsChanged"];return n}const index_es_yr={INVALID_METHOD:{message:"Invalid method.",code:1001},INVALID_EVENT:{message:"Invalid event.",code:1002},INVALID_UPDATE_REQUEST:{message:"Invalid update request.",code:1003},INVALID_EXTEND_REQUEST:{message:"Invalid extend request.",code:1004},INVALID_SESSION_SETTLE_REQUEST:{message:"Invalid session settle request.",code:1005},UNAUTHORIZED_METHOD:{message:"Unauthorized method.",code:3001},UNAUTHORIZED_EVENT:{message:"Unauthorized event.",code:3002},UNAUTHORIZED_UPDATE_REQUEST:{message:"Unauthorized update request.",code:3003},UNAUTHORIZED_EXTEND_REQUEST:{message:"Unauthorized extend request.",code:3004},USER_REJECTED:{message:"User rejected.",code:5e3},USER_REJECTED_CHAINS:{message:"User rejected chains.",code:5001},USER_REJECTED_METHODS:{message:"User rejected methods.",code:5002},USER_REJECTED_EVENTS:{message:"User rejected events.",code:5003},UNSUPPORTED_CHAINS:{message:"Unsupported chains.",code:5100},UNSUPPORTED_METHODS:{message:"Unsupported methods.",code:5101},UNSUPPORTED_EVENTS:{message:"Unsupported events.",code:5102},UNSUPPORTED_ACCOUNTS:{message:"Unsupported accounts.",code:5103},UNSUPPORTED_NAMESPACE_KEY:{message:"Unsupported namespace key.",code:5104},USER_DISCONNECTED:{message:"User disconnected.",code:6e3},SESSION_SETTLEMENT_FAILED:{message:"Session settlement failed.",code:7e3},WC_METHOD_UNSUPPORTED:{message:"Unsupported wc_ method.",code:10001}},index_es_mr={NOT_INITIALIZED:{message:"Not initialized.",code:1},NO_MATCHING_KEY:{message:"No matching key.",code:2},RESTORE_WILL_OVERRIDE:{message:"Restore will override.",code:3},RESUBSCRIBED:{message:"Resubscribed.",code:4},MISSING_OR_INVALID:{message:"Missing or invalid.",code:5},EXPIRED:{message:"Expired.",code:6},UNKNOWN_TYPE:{message:"Unknown type.",code:7},MISMATCHED_TOPIC:{message:"Mismatched topic.",code:8},NON_CONFORMING_NAMESPACES:{message:"Non conforming namespaces.",code:9}};function dist_index_es_te(e,t){const{message:n,code:r}=index_es_mr[e];return{message:t?`${n} ${t}`:n,code:r}}function index_es_de(e,t){const{message:n,code:r}=index_es_yr[e];return{message:t?`${n} ${t}`:n,code:r}}function index_es_$e(e,t){return Array.isArray(e)?typeof t<"u"&&e.length?e.every(t):!0:!1}function index_es_qe(e){return Object.getPrototypeOf(e)===Object.prototype&&Object.keys(e).length}function ae(e){return typeof e>"u"}function index_es_q(e,t){return t&&ae(e)?!0:typeof e=="string"&&!!e.trim().length}function index_es_Ge(e,t){return t&&ae(e)?!0:typeof e=="number"&&!isNaN(e)}function Pi(e,t){const{requiredNamespaces:n}=t,r=Object.keys(e.namespaces),o=Object.keys(n);let s=!0;return re(o,r)?(r.forEach(i=>{const{accounts:c,methods:u,events:a}=e.namespaces[i],l=index_es_le(c),f=n[i];(!re(index_es_Be(i,f),l)||!re(f.methods,u)||!re(f.events,a))&&(s=!1)}),s):!1}function index_es_Re(e){return index_es_q(e,!1)&&e.includes(":")?e.split(":").length===2:!1}function index_es_br(e){if(index_es_q(e,!1)&&e.includes(":")){const t=e.split(":");if(t.length===3){const n=t[0]+":"+t[1];return!!t[2]&&index_es_Re(n)}}return!1}function Bi(e){function t(n){try{return typeof new URL(n)<"u"}catch{return!1}}try{if(index_es_q(e,!1)){if(t(e))return!0;const n=index_es_rt(e);return t(n)}}catch{}return!1}function Li(e){var t;return(t=e?.proposer)==null?void 0:t.publicKey}function ji(e){return e?.topic}function Ci(e,t){let n=null;return index_es_q(e?.publicKey,!1)||(n=dist_index_es_te("MISSING_OR_INVALID",`${t} controller public key should be a string`)),n}function index_es_Rt(e){let t=!0;return index_es_$e(e)?e.length&&(t=e.every(n=>index_es_q(n,!1))):t=!1,t}function index_es_wr(e,t,n){let r=null;return index_es_$e(t)&&t.length?t.forEach(o=>{r||index_es_Re(o)||(r=index_es_de("UNSUPPORTED_CHAINS",`${n}, chain ${o} should be a string and conform to "namespace:chainId" format`))}):index_es_Re(e)||(r=index_es_de("UNSUPPORTED_CHAINS",`${n}, chains must be defined as "namespace:chainId" e.g. "eip155:1": {...} in the namespace key OR as an array of CAIP-2 chainIds e.g. eip155: { chains: ["eip155:1", "eip155:5"] }`)),r}function index_es_Er(e,t,n){let r=null;return Object.entries(e).forEach(([o,s])=>{if(r)return;const i=index_es_wr(o,index_es_Be(o,s),`${t} ${n}`);i&&(r=i)}),r}function index_es_vr(e,t){let n=null;return index_es_$e(e)?e.forEach(r=>{n||index_es_br(r)||(n=index_es_de("UNSUPPORTED_ACCOUNTS",`${t}, account ${r} should be a string and conform to "namespace:chainId:address" format`))}):n=index_es_de("UNSUPPORTED_ACCOUNTS",`${t}, accounts should be an array of strings conforming to "namespace:chainId:address" format`),n}function index_es_xr(e,t){let n=null;return Object.values(e).forEach(r=>{if(n)return;const o=index_es_vr(r?.accounts,`${t} namespace`);o&&(n=o)}),n}function index_es_Ir(e,t){let n=null;return index_es_Rt(e?.methods)?index_es_Rt(e?.events)||(n=index_es_de("UNSUPPORTED_EVENTS",`${t}, events should be an array of strings or empty array for no events`)):n=index_es_de("UNSUPPORTED_METHODS",`${t}, methods should be an array of strings or empty array for no methods`),n}function index_es_Pt(e,t){let n=null;return Object.values(e).forEach(r=>{if(n)return;const o=index_es_Ir(r,`${t}, namespace`);o&&(n=o)}),n}function ki(e,t,n){let r=null;if(e&&index_es_qe(e)){const o=index_es_Pt(e,t);o&&(r=o);const s=index_es_Er(e,t,n);s&&(r=s)}else r=dist_index_es_te("MISSING_OR_INVALID",`${t}, ${n} should be an object with data`);return r}function index_es_Or(e,t){let n=null;if(e&&index_es_qe(e)){const r=index_es_Pt(e,t);r&&(n=r);const o=index_es_xr(e,t);o&&(n=o)}else n=dist_index_es_te("MISSING_OR_INVALID",`${t}, namespaces should be an object with data`);return n}function index_es_Ar(e){return index_es_q(e.protocol,!0)}function Di(e,t){let n=!1;return t&&!e?n=!0:e&&index_es_$e(e)&&e.length&&e.forEach(r=>{n=index_es_Ar(r)}),n}function Mi(e){return typeof e=="number"}function Vi(e){return typeof e<"u"&&typeof e!==null}function Hi(e){return!(!e||typeof e!="object"||!e.code||!index_es_Ge(e.code,!1)||!e.message||!index_es_q(e.message,!1))}function Ki(e){return!(ae(e)||!index_es_q(e.method,!1))}function Fi(e){return!(ae(e)||ae(e.result)&&ae(e.error)||!index_es_Ge(e.id,!1)||!index_es_q(e.jsonrpc,!1))}function qi(e){return!(ae(e)||!index_es_q(e.name,!1))}function Gi(e,t){return!(!index_es_Re(t)||!index_es_lr(e).includes(t))}function Wi(e,t,n){return index_es_q(n,!1)?index_es_dr(e,t).includes(n):!1}function zi(e,t,n){return index_es_q(n,!1)?index_es_hr(e,t).includes(n):!1}function index_es_Nr(e,t,n){let r=null;const o=Ji(e),s=Yi(t),i=Object.keys(o),c=Object.keys(s),u=index_es_Sr(Object.keys(e)),a=index_es_Sr(Object.keys(t)),l=u.filter(f=>!a.includes(f));return l.length&&(r=dist_index_es_te("NON_CONFORMING_NAMESPACES",`${n} namespaces keys don't satisfy requiredNamespaces.
      Required: ${l.toString()}
      Received: ${Object.keys(t).toString()}`)),re(i,c)||(r=dist_index_es_te("NON_CONFORMING_NAMESPACES",`${n} namespaces chains don't satisfy required namespaces.
      Required: ${i.toString()}
      Approved: ${c.toString()}`)),Object.keys(t).forEach(f=>{if(!f.includes(":")||r)return;const d=index_es_le(t[f].accounts);d.includes(f)||(r=dist_index_es_te("NON_CONFORMING_NAMESPACES",`${n} namespaces accounts don't satisfy namespace accounts for ${f}
        Required: ${f}
        Approved: ${d.toString()}`))}),i.forEach(f=>{r||(re(o[f].methods,s[f].methods)?re(o[f].events,s[f].events)||(r=dist_index_es_te("NON_CONFORMING_NAMESPACES",`${n} namespaces events don't satisfy namespace events for ${f}`)):r=dist_index_es_te("NON_CONFORMING_NAMESPACES",`${n} namespaces methods don't satisfy namespace methods for ${f}`))}),r}function Ji(e){const t={};return Object.keys(e).forEach(n=>{var r;n.includes(":")?t[n]=e[n]:(r=e[n].chains)==null||r.forEach(o=>{t[o]={methods:e[n].methods,events:e[n].events}})}),t}function index_es_Sr(e){return[...new Set(e.map(t=>t.includes(":")?t.split(":")[0]:t))]}function Yi(e){const t={};return Object.keys(e).forEach(n=>{if(n.includes(":"))t[n]=e[n];else{const r=index_es_le(e[n].accounts);r?.forEach(o=>{t[o]={accounts:e[n].accounts.filter(s=>s.includes(`${o}:`)),methods:e[n].methods,events:e[n].events}})}}),t}function Xi(e,t){return index_es_Ge(e,!1)&&e<=t.max&&e>=t.min}function Zi(){const e=ue();return new Promise(t=>{switch(e){case index_es_H.browser:t(index_es_Ur());break;case index_es_H.reactNative:t(index_es_r());break;case index_es_H.node:t(index_es_Tr());break;default:t(!0)}})}function index_es_Ur(){return index_es_Ae()&&navigator?.onLine}async function index_es_r(){if(ne()&&typeof global<"u"&&global!=null&&global.NetInfo){const e=await(global==null?void 0:global.NetInfo.fetch());return e?.isConnected}return!0}function index_es_Tr(){return!0}function Qi(e){switch(ue()){case index_es_H.browser:index_es_$r(e);break;case index_es_H.reactNative:index_es_Rr(e);break;case index_es_H.node:break}}function index_es_$r(e){!ne()&&index_es_Ae()&&(window.addEventListener("online",()=>e(!0)),window.addEventListener("offline",()=>e(!1)))}function index_es_Rr(e){ne()&&typeof global<"u"&&global!=null&&global.NetInfo&&global?.NetInfo.addEventListener(t=>e(t?.isConnected))}const index_es_Bt={};class ec{static get(t){return index_es_Bt[t]}static set(t,n){index_es_Bt[t]=n}static delete(t){delete index_es_Bt[t]}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/events/dist/esm/events.js
class IEvents {
}
//# sourceMappingURL=events.js.map
;// ./node_modules/@walletconnect/heartbeat/dist/index.es.js
class dist_index_es_n extends IEvents{constructor(e){super()}}const s=cjs.FIVE_SECONDS,r={pulse:"heartbeat_pulse"};class index_es_i extends dist_index_es_n{constructor(e){super(e),this.events=new external_events_.EventEmitter,this.interval=s,this.interval=e?.interval||s}static async init(e){const t=new index_es_i(e);return await t.init(),t}async init(){await this.initialize()}stop(){clearInterval(this.intervalRef)}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeListener(e,t){this.events.removeListener(e,t)}async initialize(){this.intervalRef=setInterval(()=>this.pulse(),(0,cjs.toMiliseconds)(this.interval))}pulse(){this.events.emit(r.pulse)}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/destr/dist/index.mjs
const suspectProtoRx = /"(?:_|\\u0{2}5[Ff]){2}(?:p|\\u0{2}70)(?:r|\\u0{2}72)(?:o|\\u0{2}6[Ff])(?:t|\\u0{2}74)(?:o|\\u0{2}6[Ff])(?:_|\\u0{2}5[Ff]){2}"\s*:/;
const suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
const JsonSigRx = /^\s*["[{]|^\s*-?\d{1,16}(\.\d{1,17})?([Ee][+-]?\d+)?\s*$/;
function jsonParseTransform(key, value) {
  if (key === "__proto__" || key === "constructor" && value && typeof value === "object" && "prototype" in value) {
    warnKeyDropped(key);
    return;
  }
  return value;
}
function warnKeyDropped(key) {
  console.warn(`[destr] Dropping "${key}" key to prevent prototype pollution.`);
}
function destr(value, options = {}) {
  if (typeof value !== "string") {
    return value;
  }
  const _value = value.trim();
  if (
    // eslint-disable-next-line unicorn/prefer-at
    value[0] === '"' && value.endsWith('"') && !value.includes("\\")
  ) {
    return _value.slice(1, -1);
  }
  if (_value.length <= 9) {
    const _lval = _value.toLowerCase();
    if (_lval === "true") {
      return true;
    }
    if (_lval === "false") {
      return false;
    }
    if (_lval === "undefined") {
      return void 0;
    }
    if (_lval === "null") {
      return null;
    }
    if (_lval === "nan") {
      return Number.NaN;
    }
    if (_lval === "infinity") {
      return Number.POSITIVE_INFINITY;
    }
    if (_lval === "-infinity") {
      return Number.NEGATIVE_INFINITY;
    }
  }
  if (!JsonSigRx.test(value)) {
    if (options.strict) {
      throw new SyntaxError("[destr] Invalid JSON");
    }
    return value;
  }
  try {
    if (suspectProtoRx.test(value) || suspectConstructorRx.test(value)) {
      if (options.strict) {
        throw new Error("[destr] Possible prototype pollution");
      }
      return JSON.parse(value, jsonParseTransform);
    }
    return JSON.parse(value);
  } catch (error) {
    if (options.strict) {
      throw error;
    }
    return value;
  }
}
function safeDestr(value, options = {}) {
  return destr(value, { ...options, strict: true });
}



;// ./node_modules/unstorage/dist/shared/unstorage.mNKHTF5Y.mjs
function wrapToPromise(value) {
  if (!value || typeof value.then !== "function") {
    return Promise.resolve(value);
  }
  return value;
}
function asyncCall(function_, ...arguments_) {
  try {
    return wrapToPromise(function_(...arguments_));
  } catch (error) {
    return Promise.reject(error);
  }
}
function isPrimitive(value) {
  const type = typeof value;
  return value === null || type !== "object" && type !== "function";
}
function isPureObject(value) {
  const proto = Object.getPrototypeOf(value);
  return !proto || proto.isPrototypeOf(Object);
}
function stringify(value) {
  if (isPrimitive(value)) {
    return String(value);
  }
  if (isPureObject(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value.toJSON === "function") {
    return stringify(value.toJSON());
  }
  throw new Error("[unstorage] Cannot stringify value!");
}
const BASE64_PREFIX = "base64:";
function serializeRaw(value) {
  if (typeof value === "string") {
    return value;
  }
  return BASE64_PREFIX + base64Encode(value);
}
function deserializeRaw(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (!value.startsWith(BASE64_PREFIX)) {
    return value;
  }
  return base64Decode(value.slice(BASE64_PREFIX.length));
}
function base64Decode(input) {
  if (globalThis.Buffer) {
    return Buffer.from(input, "base64");
  }
  return Uint8Array.from(
    globalThis.atob(input),
    (c) => c.codePointAt(0)
  );
}
function base64Encode(input) {
  if (globalThis.Buffer) {
    return Buffer.from(input).toString("base64");
  }
  return globalThis.btoa(String.fromCodePoint(...input));
}

const storageKeyProperties = (/* unused pure expression or super */ null && ([
  "has",
  "hasItem",
  "get",
  "getItem",
  "getItemRaw",
  "set",
  "setItem",
  "setItemRaw",
  "del",
  "remove",
  "removeItem",
  "getMeta",
  "setMeta",
  "removeMeta",
  "getKeys",
  "clear",
  "mount",
  "unmount"
]));
function prefixStorage(storage, base) {
  base = unstorage_mNKHTF5Y_normalizeBaseKey(base);
  if (!base) {
    return storage;
  }
  const nsStorage = { ...storage };
  for (const property of storageKeyProperties) {
    nsStorage[property] = (key = "", ...args) => (
      // @ts-ignore
      storage[property](base + key, ...args)
    );
  }
  nsStorage.getKeys = (key = "", ...arguments_) => storage.getKeys(base + key, ...arguments_).then((keys) => keys.map((key2) => key2.slice(base.length)));
  return nsStorage;
}
function normalizeKey(key) {
  if (!key) {
    return "";
  }
  return key.split("?")[0]?.replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "") || "";
}
function joinKeys(...keys) {
  return normalizeKey(keys.join(":"));
}
function unstorage_mNKHTF5Y_normalizeBaseKey(base) {
  base = normalizeKey(base);
  return base ? base + ":" : "";
}
function filterKeyByDepth(key, depth) {
  if (depth === void 0) {
    return true;
  }
  let substrCount = 0;
  let index = key.indexOf(":");
  while (index > -1) {
    substrCount++;
    index = key.indexOf(":", index + 1);
  }
  return substrCount <= depth;
}
function filterKeyByBase(key, base) {
  if (base) {
    return key.startsWith(base) && key[key.length - 1] !== "$";
  }
  return key[key.length - 1] !== "$";
}



;// ./node_modules/unstorage/dist/index.mjs




function defineDriver(factory) {
  return factory;
}

const DRIVER_NAME = "memory";
const memory = defineDriver(() => {
  const data = /* @__PURE__ */ new Map();
  return {
    name: DRIVER_NAME,
    getInstance: () => data,
    hasItem(key) {
      return data.has(key);
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    getItemRaw(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    setItemRaw(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
    getKeys() {
      return [...data.keys()];
    },
    clear() {
      data.clear();
    },
    dispose() {
      data.clear();
    }
  };
});

function createStorage(options = {}) {
  const context = {
    mounts: { "": options.driver || memory() },
    mountpoints: [""],
    watching: false,
    watchListeners: [],
    unwatch: {}
  };
  const getMount = (key) => {
    for (const base of context.mountpoints) {
      if (key.startsWith(base)) {
        return {
          base,
          relativeKey: key.slice(base.length),
          driver: context.mounts[base]
        };
      }
    }
    return {
      base: "",
      relativeKey: key,
      driver: context.mounts[""]
    };
  };
  const getMounts = (base, includeParent) => {
    return context.mountpoints.filter(
      (mountpoint) => mountpoint.startsWith(base) || includeParent && base.startsWith(mountpoint)
    ).map((mountpoint) => ({
      relativeBase: base.length > mountpoint.length ? base.slice(mountpoint.length) : void 0,
      mountpoint,
      driver: context.mounts[mountpoint]
    }));
  };
  const onChange = (event, key) => {
    if (!context.watching) {
      return;
    }
    key = normalizeKey(key);
    for (const listener of context.watchListeners) {
      listener(event, key);
    }
  };
  const startWatch = async () => {
    if (context.watching) {
      return;
    }
    context.watching = true;
    for (const mountpoint in context.mounts) {
      context.unwatch[mountpoint] = await watch(
        context.mounts[mountpoint],
        onChange,
        mountpoint
      );
    }
  };
  const stopWatch = async () => {
    if (!context.watching) {
      return;
    }
    for (const mountpoint in context.unwatch) {
      await context.unwatch[mountpoint]();
    }
    context.unwatch = {};
    context.watching = false;
  };
  const runBatch = (items, commonOptions, cb) => {
    const batches = /* @__PURE__ */ new Map();
    const getBatch = (mount) => {
      let batch = batches.get(mount.base);
      if (!batch) {
        batch = {
          driver: mount.driver,
          base: mount.base,
          items: []
        };
        batches.set(mount.base, batch);
      }
      return batch;
    };
    for (const item of items) {
      const isStringItem = typeof item === "string";
      const key = normalizeKey(isStringItem ? item : item.key);
      const value = isStringItem ? void 0 : item.value;
      const options2 = isStringItem || !item.options ? commonOptions : { ...commonOptions, ...item.options };
      const mount = getMount(key);
      getBatch(mount).items.push({
        key,
        value,
        relativeKey: mount.relativeKey,
        options: options2
      });
    }
    return Promise.all([...batches.values()].map((batch) => cb(batch))).then(
      (r) => r.flat()
    );
  };
  const storage = {
    // Item
    hasItem(key, opts = {}) {
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      return asyncCall(driver.hasItem, relativeKey, opts);
    },
    getItem(key, opts = {}) {
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      return asyncCall(driver.getItem, relativeKey, opts).then(
        (value) => destr(value)
      );
    },
    getItems(items, commonOptions = {}) {
      return runBatch(items, commonOptions, (batch) => {
        if (batch.driver.getItems) {
          return asyncCall(
            batch.driver.getItems,
            batch.items.map((item) => ({
              key: item.relativeKey,
              options: item.options
            })),
            commonOptions
          ).then(
            (r) => r.map((item) => ({
              key: joinKeys(batch.base, item.key),
              value: destr(item.value)
            }))
          );
        }
        return Promise.all(
          batch.items.map((item) => {
            return asyncCall(
              batch.driver.getItem,
              item.relativeKey,
              item.options
            ).then((value) => ({
              key: item.key,
              value: destr(value)
            }));
          })
        );
      });
    },
    getItemRaw(key, opts = {}) {
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      if (driver.getItemRaw) {
        return asyncCall(driver.getItemRaw, relativeKey, opts);
      }
      return asyncCall(driver.getItem, relativeKey, opts).then(
        (value) => deserializeRaw(value)
      );
    },
    async setItem(key, value, opts = {}) {
      if (value === void 0) {
        return storage.removeItem(key);
      }
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      if (!driver.setItem) {
        return;
      }
      await asyncCall(driver.setItem, relativeKey, stringify(value), opts);
      if (!driver.watch) {
        onChange("update", key);
      }
    },
    async setItems(items, commonOptions) {
      await runBatch(items, commonOptions, async (batch) => {
        if (batch.driver.setItems) {
          return asyncCall(
            batch.driver.setItems,
            batch.items.map((item) => ({
              key: item.relativeKey,
              value: stringify(item.value),
              options: item.options
            })),
            commonOptions
          );
        }
        if (!batch.driver.setItem) {
          return;
        }
        await Promise.all(
          batch.items.map((item) => {
            return asyncCall(
              batch.driver.setItem,
              item.relativeKey,
              stringify(item.value),
              item.options
            );
          })
        );
      });
    },
    async setItemRaw(key, value, opts = {}) {
      if (value === void 0) {
        return storage.removeItem(key, opts);
      }
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      if (driver.setItemRaw) {
        await asyncCall(driver.setItemRaw, relativeKey, value, opts);
      } else if (driver.setItem) {
        await asyncCall(driver.setItem, relativeKey, serializeRaw(value), opts);
      } else {
        return;
      }
      if (!driver.watch) {
        onChange("update", key);
      }
    },
    async removeItem(key, opts = {}) {
      if (typeof opts === "boolean") {
        opts = { removeMeta: opts };
      }
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      if (!driver.removeItem) {
        return;
      }
      await asyncCall(driver.removeItem, relativeKey, opts);
      if (opts.removeMeta || opts.removeMata) {
        await asyncCall(driver.removeItem, relativeKey + "$", opts);
      }
      if (!driver.watch) {
        onChange("remove", key);
      }
    },
    // Meta
    async getMeta(key, opts = {}) {
      if (typeof opts === "boolean") {
        opts = { nativeOnly: opts };
      }
      key = normalizeKey(key);
      const { relativeKey, driver } = getMount(key);
      const meta = /* @__PURE__ */ Object.create(null);
      if (driver.getMeta) {
        Object.assign(meta, await asyncCall(driver.getMeta, relativeKey, opts));
      }
      if (!opts.nativeOnly) {
        const value = await asyncCall(
          driver.getItem,
          relativeKey + "$",
          opts
        ).then((value_) => destr(value_));
        if (value && typeof value === "object") {
          if (typeof value.atime === "string") {
            value.atime = new Date(value.atime);
          }
          if (typeof value.mtime === "string") {
            value.mtime = new Date(value.mtime);
          }
          Object.assign(meta, value);
        }
      }
      return meta;
    },
    setMeta(key, value, opts = {}) {
      return this.setItem(key + "$", value, opts);
    },
    removeMeta(key, opts = {}) {
      return this.removeItem(key + "$", opts);
    },
    // Keys
    async getKeys(base, opts = {}) {
      base = unstorage_mNKHTF5Y_normalizeBaseKey(base);
      const mounts = getMounts(base, true);
      let maskedMounts = [];
      const allKeys = [];
      let allMountsSupportMaxDepth = true;
      for (const mount of mounts) {
        if (!mount.driver.flags?.maxDepth) {
          allMountsSupportMaxDepth = false;
        }
        const rawKeys = await asyncCall(
          mount.driver.getKeys,
          mount.relativeBase,
          opts
        );
        for (const key of rawKeys) {
          const fullKey = mount.mountpoint + normalizeKey(key);
          if (!maskedMounts.some((p) => fullKey.startsWith(p))) {
            allKeys.push(fullKey);
          }
        }
        maskedMounts = [
          mount.mountpoint,
          ...maskedMounts.filter((p) => !p.startsWith(mount.mountpoint))
        ];
      }
      const shouldFilterByDepth = opts.maxDepth !== void 0 && !allMountsSupportMaxDepth;
      return allKeys.filter(
        (key) => (!shouldFilterByDepth || filterKeyByDepth(key, opts.maxDepth)) && filterKeyByBase(key, base)
      );
    },
    // Utils
    async clear(base, opts = {}) {
      base = unstorage_mNKHTF5Y_normalizeBaseKey(base);
      await Promise.all(
        getMounts(base, false).map(async (m) => {
          if (m.driver.clear) {
            return asyncCall(m.driver.clear, m.relativeBase, opts);
          }
          if (m.driver.removeItem) {
            const keys = await m.driver.getKeys(m.relativeBase || "", opts);
            return Promise.all(
              keys.map((key) => m.driver.removeItem(key, opts))
            );
          }
        })
      );
    },
    async dispose() {
      await Promise.all(
        Object.values(context.mounts).map((driver) => dispose(driver))
      );
    },
    async watch(callback) {
      await startWatch();
      context.watchListeners.push(callback);
      return async () => {
        context.watchListeners = context.watchListeners.filter(
          (listener) => listener !== callback
        );
        if (context.watchListeners.length === 0) {
          await stopWatch();
        }
      };
    },
    async unwatch() {
      context.watchListeners = [];
      await stopWatch();
    },
    // Mount
    mount(base, driver) {
      base = unstorage_mNKHTF5Y_normalizeBaseKey(base);
      if (base && context.mounts[base]) {
        throw new Error(`already mounted at ${base}`);
      }
      if (base) {
        context.mountpoints.push(base);
        context.mountpoints.sort((a, b) => b.length - a.length);
      }
      context.mounts[base] = driver;
      if (context.watching) {
        Promise.resolve(watch(driver, onChange, base)).then((unwatcher) => {
          context.unwatch[base] = unwatcher;
        }).catch(console.error);
      }
      return storage;
    },
    async unmount(base, _dispose = true) {
      base = unstorage_mNKHTF5Y_normalizeBaseKey(base);
      if (!base || !context.mounts[base]) {
        return;
      }
      if (context.watching && base in context.unwatch) {
        context.unwatch[base]?.();
        delete context.unwatch[base];
      }
      if (_dispose) {
        await dispose(context.mounts[base]);
      }
      context.mountpoints = context.mountpoints.filter((key) => key !== base);
      delete context.mounts[base];
    },
    getMount(key = "") {
      key = normalizeKey(key) + ":";
      const m = getMount(key);
      return {
        driver: m.driver,
        base: m.base
      };
    },
    getMounts(base = "", opts = {}) {
      base = normalizeKey(base);
      const mounts = getMounts(base, opts.parents);
      return mounts.map((m) => ({
        driver: m.driver,
        base: m.mountpoint
      }));
    },
    // Aliases
    keys: (base, opts = {}) => storage.getKeys(base, opts),
    get: (key, opts = {}) => storage.getItem(key, opts),
    set: (key, value, opts = {}) => storage.setItem(key, value, opts),
    has: (key, opts = {}) => storage.hasItem(key, opts),
    del: (key, opts = {}) => storage.removeItem(key, opts),
    remove: (key, opts = {}) => storage.removeItem(key, opts)
  };
  return storage;
}
async function snapshot(storage, base) {
  base = normalizeBaseKey(base);
  const keys = await storage.getKeys(base);
  const snapshot2 = {};
  await Promise.all(
    keys.map(async (key) => {
      snapshot2[key.slice(base.length)] = await storage.getItem(key);
    })
  );
  return snapshot2;
}
async function restoreSnapshot(driver, snapshot2, base = "") {
  base = normalizeBaseKey(base);
  await Promise.all(
    Object.entries(snapshot2).map((e) => driver.setItem(base + e[0], e[1]))
  );
}
function watch(driver, onChange, base) {
  return driver.watch ? driver.watch((event, key) => onChange(event, base + key)) : () => {
  };
}
async function dispose(driver) {
  if (typeof driver.dispose === "function") {
    await asyncCall(driver.dispose);
  }
}

const builtinDrivers = {
  "azure-app-configuration": "unstorage/drivers/azure-app-configuration",
  "azureAppConfiguration": "unstorage/drivers/azure-app-configuration",
  "azure-cosmos": "unstorage/drivers/azure-cosmos",
  "azureCosmos": "unstorage/drivers/azure-cosmos",
  "azure-key-vault": "unstorage/drivers/azure-key-vault",
  "azureKeyVault": "unstorage/drivers/azure-key-vault",
  "azure-storage-blob": "unstorage/drivers/azure-storage-blob",
  "azureStorageBlob": "unstorage/drivers/azure-storage-blob",
  "azure-storage-table": "unstorage/drivers/azure-storage-table",
  "azureStorageTable": "unstorage/drivers/azure-storage-table",
  "capacitor-preferences": "unstorage/drivers/capacitor-preferences",
  "capacitorPreferences": "unstorage/drivers/capacitor-preferences",
  "cloudflare-kv-binding": "unstorage/drivers/cloudflare-kv-binding",
  "cloudflareKVBinding": "unstorage/drivers/cloudflare-kv-binding",
  "cloudflare-kv-http": "unstorage/drivers/cloudflare-kv-http",
  "cloudflareKVHttp": "unstorage/drivers/cloudflare-kv-http",
  "cloudflare-r2-binding": "unstorage/drivers/cloudflare-r2-binding",
  "cloudflareR2Binding": "unstorage/drivers/cloudflare-r2-binding",
  "db0": "unstorage/drivers/db0",
  "deno-kv-node": "unstorage/drivers/deno-kv-node",
  "denoKVNode": "unstorage/drivers/deno-kv-node",
  "deno-kv": "unstorage/drivers/deno-kv",
  "denoKV": "unstorage/drivers/deno-kv",
  "fs-lite": "unstorage/drivers/fs-lite",
  "fsLite": "unstorage/drivers/fs-lite",
  "fs": "unstorage/drivers/fs",
  "github": "unstorage/drivers/github",
  "http": "unstorage/drivers/http",
  "indexedb": "unstorage/drivers/indexedb",
  "localstorage": "unstorage/drivers/localstorage",
  "lru-cache": "unstorage/drivers/lru-cache",
  "lruCache": "unstorage/drivers/lru-cache",
  "memory": "unstorage/drivers/memory",
  "mongodb": "unstorage/drivers/mongodb",
  "netlify-blobs": "unstorage/drivers/netlify-blobs",
  "netlifyBlobs": "unstorage/drivers/netlify-blobs",
  "null": "unstorage/drivers/null",
  "overlay": "unstorage/drivers/overlay",
  "planetscale": "unstorage/drivers/planetscale",
  "redis": "unstorage/drivers/redis",
  "s3": "unstorage/drivers/s3",
  "session-storage": "unstorage/drivers/session-storage",
  "sessionStorage": "unstorage/drivers/session-storage",
  "uploadthing": "unstorage/drivers/uploadthing",
  "upstash": "unstorage/drivers/upstash",
  "vercel-blob": "unstorage/drivers/vercel-blob",
  "vercelBlob": "unstorage/drivers/vercel-blob",
  "vercel-kv": "unstorage/drivers/vercel-kv",
  "vercelKV": "unstorage/drivers/vercel-kv"
};



;// ./node_modules/idb-keyval/dist/index.js
function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        // @ts-ignore - file size hacks
        request.oncomplete = request.onsuccess = () => resolve(request.result);
        // @ts-ignore - file size hacks
        request.onabort = request.onerror = () => reject(request.error);
    });
}
function createStore(dbName, storeName) {
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    const dbp = promisifyRequest(request);
    return (txMode, callback) => dbp.then((db) => callback(db.transaction(storeName, txMode).objectStore(storeName)));
}
let defaultGetStoreFunc;
function defaultGetStore() {
    if (!defaultGetStoreFunc) {
        defaultGetStoreFunc = createStore('keyval-store', 'keyval');
    }
    return defaultGetStoreFunc;
}
/**
 * Get a value by its key.
 *
 * @param key
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function get(key, customStore = defaultGetStore()) {
    return customStore('readonly', (store) => promisifyRequest(store.get(key)));
}
/**
 * Set a value with a key.
 *
 * @param key
 * @param value
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function set(key, value, customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => {
        store.put(value, key);
        return promisifyRequest(store.transaction);
    });
}
/**
 * Set multiple values at once. This is faster than calling set() multiple times.
 * It's also atomic – if one of the pairs can't be added, none will be added.
 *
 * @param entries Array of entries, where each entry is an array of `[key, value]`.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function setMany(entries, customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => {
        entries.forEach((entry) => store.put(entry[1], entry[0]));
        return promisifyRequest(store.transaction);
    });
}
/**
 * Get multiple values by their keys
 *
 * @param keys
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function getMany(keys, customStore = defaultGetStore()) {
    return customStore('readonly', (store) => Promise.all(keys.map((key) => promisifyRequest(store.get(key)))));
}
/**
 * Update a value. This lets you see the old value and update it as an atomic operation.
 *
 * @param key
 * @param updater A callback that takes the old value and returns a new value.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function update(key, updater, customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => 
    // Need to create the promise manually.
    // If I try to chain promises, the transaction closes in browsers
    // that use a promise polyfill (IE10/11).
    new Promise((resolve, reject) => {
        store.get(key).onsuccess = function () {
            try {
                store.put(updater(this.result), key);
                resolve(promisifyRequest(store.transaction));
            }
            catch (err) {
                reject(err);
            }
        };
    }));
}
/**
 * Delete a particular key from the store.
 *
 * @param key
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function del(key, customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => {
        store.delete(key);
        return promisifyRequest(store.transaction);
    });
}
/**
 * Delete multiple keys at once.
 *
 * @param keys List of keys to delete.
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function delMany(keys, customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => {
        keys.forEach((key) => store.delete(key));
        return promisifyRequest(store.transaction);
    });
}
/**
 * Clear all values in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function clear(customStore = defaultGetStore()) {
    return customStore('readwrite', (store) => {
        store.clear();
        return promisifyRequest(store.transaction);
    });
}
function eachCursor(store, callback) {
    store.openCursor().onsuccess = function () {
        if (!this.result)
            return;
        callback(this.result);
        this.result.continue();
    };
    return promisifyRequest(store.transaction);
}
/**
 * Get all keys in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function keys(customStore = defaultGetStore()) {
    return customStore('readonly', (store) => {
        // Fast path for modern browsers
        if (store.getAllKeys) {
            return promisifyRequest(store.getAllKeys());
        }
        const items = [];
        return eachCursor(store, (cursor) => items.push(cursor.key)).then(() => items);
    });
}
/**
 * Get all values in the store.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function values(customStore = defaultGetStore()) {
    return customStore('readonly', (store) => {
        // Fast path for modern browsers
        if (store.getAll) {
            return promisifyRequest(store.getAll());
        }
        const items = [];
        return eachCursor(store, (cursor) => items.push(cursor.value)).then(() => items);
    });
}
/**
 * Get all entries in the store. Each entry is an array of `[key, value]`.
 *
 * @param customStore Method to get a custom store. Use with caution (see the docs).
 */
function entries(customStore = defaultGetStore()) {
    return customStore('readonly', (store) => {
        // Fast path for modern browsers
        // (although, hopefully we'll get a simpler path some day)
        if (store.getAll && store.getAllKeys) {
            return Promise.all([
                promisifyRequest(store.getAllKeys()),
                promisifyRequest(store.getAll()),
            ]).then(([keys, values]) => keys.map((key, i) => [key, values[i]]));
        }
        const items = [];
        return customStore('readonly', (store) => eachCursor(store, (cursor) => items.push([cursor.key, cursor.value])).then(() => items));
    });
}



;// ./node_modules/@walletconnect/keyvaluestorage/dist/index.es.js
function index_es_C(i){return i}const dist_index_es_x="idb-keyval";var index_es_z=(i={})=>{const t=i.base&&i.base.length>0?`${i.base}:`:"",e=s=>t+s;let n;return i.dbName&&i.storeName&&(n=createStore(i.dbName,i.storeName)),{name:dist_index_es_x,options:i,async hasItem(s){return!(typeof await get(e(s),n)>"u")},async getItem(s){return await get(e(s),n)??null},setItem(s,a){return set(e(s),a,n)},removeItem(s){return del(e(s),n)},getKeys(){return keys(n)},clear(){return clear(n)}}};const D="WALLET_CONNECT_V2_INDEXED_DB",index_es_E="keyvaluestorage";class index_es_{constructor(){this.indexedDb=createStorage({driver:index_es_z({dbName:D,storeName:index_es_E})})}async getKeys(){return this.indexedDb.getKeys()}async getEntries(){return(await this.indexedDb.getItems(await this.indexedDb.getKeys())).map(t=>[t.key,t.value])}async getItem(t){const e=await this.indexedDb.getItem(t);if(e!==null)return e}async setItem(t,e){await this.indexedDb.setItem(t,safeJsonStringify(e))}async removeItem(t){await this.indexedDb.removeItem(t)}}var index_es_l=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{},index_es_c={exports:{}};(function(){let i;function t(){}i=t,i.prototype.getItem=function(e){return this.hasOwnProperty(e)?String(this[e]):null},i.prototype.setItem=function(e,n){this[e]=String(n)},i.prototype.removeItem=function(e){delete this[e]},i.prototype.clear=function(){const e=this;Object.keys(e).forEach(function(n){e[n]=void 0,delete e[n]})},i.prototype.key=function(e){return e=e||0,Object.keys(this)[e]},i.prototype.__defineGetter__("length",function(){return Object.keys(this).length}),typeof index_es_l<"u"&&index_es_l.localStorage?index_es_c.exports=index_es_l.localStorage:typeof window<"u"&&window.localStorage?index_es_c.exports=window.localStorage:index_es_c.exports=new t})();function dist_index_es_k(i){var t;return[i[0],safeJsonParse((t=i[1])!=null?t:"")]}class index_es_K{constructor(){this.localStorage=index_es_c.exports}async getKeys(){return Object.keys(this.localStorage)}async getEntries(){return Object.entries(this.localStorage).map(dist_index_es_k)}async getItem(t){const e=this.localStorage.getItem(t);if(e!==null)return safeJsonParse(e)}async setItem(t,e){this.localStorage.setItem(t,safeJsonStringify(e))}async removeItem(t){this.localStorage.removeItem(t)}}const index_es_N="wc_storage_version",y=1,O=async(i,t,e)=>{const n=index_es_N,s=await t.getItem(n);if(s&&s>=y){e(t);return}const a=await i.getKeys();if(!a.length){e(t);return}const m=[];for(;a.length;){const r=a.shift();if(!r)continue;const o=r.toLowerCase();if(o.includes("wc@")||o.includes("walletconnect")||o.includes("wc_")||o.includes("wallet_connect")){const f=await i.getItem(r);await t.setItem(r,f),m.push(r)}}await t.setItem(n,y),e(t),index_es_j(i,m)},index_es_j=async(i,t)=>{t.length&&t.forEach(async e=>{await i.removeItem(e)})};class index_es_h{constructor(){this.initialized=!1,this.setInitialized=e=>{this.storage=e,this.initialized=!0};const t=new index_es_K;this.storage=t;try{const e=new index_es_;O(t,e,this.setInitialized)}catch{this.initialized=!0}}async getKeys(){return await this.initialize(),this.storage.getKeys()}async getEntries(){return await this.initialize(),this.storage.getEntries()}async getItem(t){return await this.initialize(),this.storage.getItem(t)}async setItem(t,e){return await this.initialize(),this.storage.setItem(t,e)}async removeItem(t){return await this.initialize(),this.storage.removeItem(t)}async initialize(){this.initialized||await new Promise(t=>{const e=setInterval(()=>{this.initialized&&(clearInterval(e),t())},20)})}}
//# sourceMappingURL=index.es.js.map

// EXTERNAL MODULE: ./node_modules/pino/pino.js
var pino = __webpack_require__(94308);
var pino_default = /*#__PURE__*/__webpack_require__.n(pino);
;// ./node_modules/@walletconnect/logger/dist/index.es.js
const dist_index_es_c={level:"info"},logger_dist_index_es_n="custom_context",dist_index_es_l=1e3*1024;class index_es_O{constructor(e){this.nodeValue=e,this.sizeInBytes=new TextEncoder().encode(this.nodeValue).length,this.next=null}get value(){return this.nodeValue}get size(){return this.sizeInBytes}}class index_es_d{constructor(e){this.head=null,this.tail=null,this.lengthInNodes=0,this.maxSizeInBytes=e,this.sizeInBytes=0}append(e){const t=new index_es_O(e);if(t.size>this.maxSizeInBytes)throw new Error(`[LinkedList] Value too big to insert into list: ${e} with size ${t.size}`);for(;this.size+t.size>this.maxSizeInBytes;)this.shift();this.head?(this.tail&&(this.tail.next=t),this.tail=t):(this.head=t,this.tail=t),this.lengthInNodes++,this.sizeInBytes+=t.size}shift(){if(!this.head)return;const e=this.head;this.head=this.head.next,this.head||(this.tail=null),this.lengthInNodes--,this.sizeInBytes-=e.size}toArray(){const e=[];let t=this.head;for(;t!==null;)e.push(t.value),t=t.next;return e}get length(){return this.lengthInNodes}get size(){return this.sizeInBytes}toOrderedArray(){return Array.from(this)}[Symbol.iterator](){let e=this.head;return{next:()=>{if(!e)return{done:!0,value:null};const t=e.value;return e=e.next,{done:!1,value:t}}}}}class L{constructor(e,t=dist_index_es_l){this.level=e??"error",this.levelValue=pino.levels.values[this.level],this.MAX_LOG_SIZE_IN_BYTES=t,this.logs=new index_es_d(this.MAX_LOG_SIZE_IN_BYTES)}forwardToConsole(e,t){t===pino.levels.values.error?console.error(e):t===pino.levels.values.warn?console.warn(e):t===pino.levels.values.debug?console.debug(e):t===pino.levels.values.trace?console.trace(e):console.log(e)}appendToLogs(e){this.logs.append(safeJsonStringify({timestamp:new Date().toISOString(),log:e}));const t=typeof e=="string"?JSON.parse(e).level:e.level;t>=this.levelValue&&this.forwardToConsole(e,t)}getLogs(){return this.logs}clearLogs(){this.logs=new index_es_d(this.MAX_LOG_SIZE_IN_BYTES)}getLogArray(){return Array.from(this.logs)}logsToBlob(e){const t=this.getLogArray();return t.push(safeJsonStringify({extraMetadata:e})),new Blob(t,{type:"application/json"})}}class index_es_m{constructor(e,t=dist_index_es_l){this.baseChunkLogger=new L(e,t)}write(e){this.baseChunkLogger.appendToLogs(e)}getLogs(){return this.baseChunkLogger.getLogs()}clearLogs(){this.baseChunkLogger.clearLogs()}getLogArray(){return this.baseChunkLogger.getLogArray()}logsToBlob(e){return this.baseChunkLogger.logsToBlob(e)}downloadLogsBlobInBrowser(e){const t=URL.createObjectURL(this.logsToBlob(e)),o=document.createElement("a");o.href=t,o.download=`walletconnect-logs-${new Date().toISOString()}.txt`,document.body.appendChild(o),o.click(),document.body.removeChild(o),URL.revokeObjectURL(t)}}class B{constructor(e,t=dist_index_es_l){this.baseChunkLogger=new L(e,t)}write(e){this.baseChunkLogger.appendToLogs(e)}getLogs(){return this.baseChunkLogger.getLogs()}clearLogs(){this.baseChunkLogger.clearLogs()}getLogArray(){return this.baseChunkLogger.getLogArray()}logsToBlob(e){return this.baseChunkLogger.logsToBlob(e)}}var logger_dist_index_es_x=Object.defineProperty,index_es_S=Object.defineProperties,dist_index_es_=Object.getOwnPropertyDescriptors,index_es_p=Object.getOwnPropertySymbols,T=Object.prototype.hasOwnProperty,dist_index_es_z=Object.prototype.propertyIsEnumerable,index_es_f=(r,e,t)=>e in r?logger_dist_index_es_x(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,i=(r,e)=>{for(var t in e||(e={}))T.call(e,t)&&index_es_f(r,t,e[t]);if(index_es_p)for(var t of index_es_p(e))dist_index_es_z.call(e,t)&&index_es_f(r,t,e[t]);return r},index_es_g=(r,e)=>index_es_S(r,dist_index_es_(e));function logger_dist_index_es_k(r){return index_es_g(i({},r),{level:r?.level||dist_index_es_c.level})}function v(r,e=logger_dist_index_es_n){return r[e]||""}function index_es_b(r,e,t=logger_dist_index_es_n){return r[t]=e,r}function index_es_y(r,e=logger_dist_index_es_n){let t="";return typeof r.bindings>"u"?t=v(r,e):t=r.bindings().context||"",t}function index_es_w(r,e,t=logger_dist_index_es_n){const o=index_es_y(r,t);return o.trim()?`${o}/${e}`:e}function dist_index_es_E(r,e,t=logger_dist_index_es_n){const o=index_es_w(r,e,t),a=r.child({context:o});return index_es_b(a,o,t)}function dist_index_es_C(r){var e,t;const o=new index_es_m((e=r.opts)==null?void 0:e.level,r.maxSizeInBytes);return{logger:pino_default()(index_es_g(i({},r.opts),{level:"trace",browser:index_es_g(i({},(t=r.opts)==null?void 0:t.browser),{write:a=>o.write(a)})})),chunkLoggerController:o}}function I(r){var e;const t=new B((e=r.opts)==null?void 0:e.level,r.maxSizeInBytes);return{logger:pino_default()(index_es_g(i({},r.opts),{level:"trace"}),t),chunkLoggerController:t}}function A(r){return typeof r.loggerOverride<"u"&&typeof r.loggerOverride!="string"?{logger:r.loggerOverride,chunkLoggerController:null}:typeof window<"u"?dist_index_es_C(r):I(r)}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/types/dist/index.es.js
var index_es_a=Object.defineProperty,index_es_u=(e,s,r)=>s in e?index_es_a(e,s,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[s]=r,types_dist_index_es_c=(e,s,r)=>index_es_u(e,typeof s!="symbol"?s+"":s,r);class dist_index_es_h extends IEvents{constructor(s){super(),this.opts=s,types_dist_index_es_c(this,"protocol","wc"),types_dist_index_es_c(this,"version",2)}}class dist_index_es_g{constructor(s,r,t){this.core=s,this.logger=r}}var dist_index_es_p=Object.defineProperty,dist_index_es_b=(e,s,r)=>s in e?dist_index_es_p(e,s,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[s]=r,index_es_v=(e,s,r)=>dist_index_es_b(e,typeof s!="symbol"?s+"":s,r);class index_es_I extends IEvents{constructor(s,r){super(),this.core=s,this.logger=r,index_es_v(this,"records",new Map)}}class dist_index_es_y{constructor(s,r){this.logger=s,this.core=r}}class dist_index_es_m extends IEvents{constructor(s,r){super(),this.relayer=s,this.logger=r}}class dist_index_es_d extends IEvents{constructor(s){super()}}class dist_index_es_f{constructor(s,r,t,q){this.core=s,this.logger=r,this.name=t}}var types_dist_index_es_E=Object.defineProperty,types_dist_index_es_x=(e,s,r)=>s in e?types_dist_index_es_E(e,s,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[s]=r,dist_index_es_w=(e,s,r)=>types_dist_index_es_x(e,typeof s!="symbol"?s+"":s,r);class types_dist_index_es_C{constructor(){dist_index_es_w(this,"map",new Map)}}class dist_index_es_P extends IEvents{constructor(s,r){super(),this.relayer=s,this.logger=r}}class dist_index_es_j{constructor(s,r){this.core=s,this.logger=r}}class dist_index_es_S extends IEvents{constructor(s,r){super(),this.core=s,this.logger=r}}class ${constructor(s,r){this.logger=s,this.core=r}}class dist_index_es_M{constructor(s,r,t){this.core=s,this.logger=r,this.store=t}}class dist_index_es_O{constructor(s,r){this.projectId=s,this.logger=r}}class index_es_R{constructor(s,r,t){this.core=s,this.logger=r,this.telemetryEnabled=t}}var index_es_T=Object.defineProperty,types_dist_index_es_k=(e,s,r)=>s in e?index_es_T(e,s,{enumerable:!0,configurable:!0,writable:!0,value:r}):e[s]=r,dist_index_es_i=(e,s,r)=>types_dist_index_es_k(e,typeof s!="symbol"?s+"":s,r);class dist_index_es_H extends (external_events_default()){constructor(){super()}}class dist_index_es_J{constructor(s){this.opts=s,dist_index_es_i(this,"protocol","wc"),dist_index_es_i(this,"version",2)}}class dist_index_es_K extends external_events_.EventEmitter{constructor(){super()}}class index_es_V{constructor(s){this.client=s}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/constants.js
const PARSE_ERROR = "PARSE_ERROR";
const INVALID_REQUEST = "INVALID_REQUEST";
const METHOD_NOT_FOUND = "METHOD_NOT_FOUND";
const INVALID_PARAMS = "INVALID_PARAMS";
const INTERNAL_ERROR = "INTERNAL_ERROR";
const SERVER_ERROR = "SERVER_ERROR";
const RESERVED_ERROR_CODES = [-32700, -32600, -32601, -32602, -32603];
const constants_SERVER_ERROR_CODE_RANGE = (/* unused pure expression or super */ null && ([-32000, -32099]));
const constants_STANDARD_ERROR_MAP = {
    [PARSE_ERROR]: { code: -32700, message: "Parse error" },
    [INVALID_REQUEST]: { code: -32600, message: "Invalid Request" },
    [METHOD_NOT_FOUND]: { code: -32601, message: "Method not found" },
    [INVALID_PARAMS]: { code: -32602, message: "Invalid params" },
    [INTERNAL_ERROR]: { code: -32603, message: "Internal error" },
    [SERVER_ERROR]: { code: -32000, message: "Server error" },
};
const constants_DEFAULT_ERROR = SERVER_ERROR;
//# sourceMappingURL=constants.js.map
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/error.js

function isServerErrorCode(code) {
    return code <= SERVER_ERROR_CODE_RANGE[0] && code >= SERVER_ERROR_CODE_RANGE[1];
}
function isReservedErrorCode(code) {
    return RESERVED_ERROR_CODES.includes(code);
}
function isValidErrorCode(code) {
    return typeof code === "number";
}
function getError(type) {
    if (!Object.keys(constants_STANDARD_ERROR_MAP).includes(type)) {
        return constants_STANDARD_ERROR_MAP[constants_DEFAULT_ERROR];
    }
    return constants_STANDARD_ERROR_MAP[type];
}
function getErrorByCode(code) {
    const match = Object.values(constants_STANDARD_ERROR_MAP).find(e => e.code === code);
    if (!match) {
        return constants_STANDARD_ERROR_MAP[constants_DEFAULT_ERROR];
    }
    return match;
}
function validateJsonRpcError(response) {
    if (typeof response.error.code === "undefined") {
        return { valid: false, error: "Missing code for JSON-RPC error" };
    }
    if (typeof response.error.message === "undefined") {
        return { valid: false, error: "Missing message for JSON-RPC error" };
    }
    if (!isValidErrorCode(response.error.code)) {
        return {
            valid: false,
            error: `Invalid error code type for JSON-RPC: ${response.error.code}`,
        };
    }
    if (isReservedErrorCode(response.error.code)) {
        const error = getErrorByCode(response.error.code);
        if (error.message !== STANDARD_ERROR_MAP[DEFAULT_ERROR].message &&
            response.error.message === error.message) {
            return {
                valid: false,
                error: `Invalid error code message for JSON-RPC: ${response.error.code}`,
            };
        }
    }
    return { valid: true };
}
function parseConnectionError(e, url, type) {
    return e.message.includes("getaddrinfo ENOTFOUND") || e.message.includes("connect ECONNREFUSED")
        ? new Error(`Unavailable ${type} RPC url at ${url}`)
        : e;
}
//# sourceMappingURL=error.js.map
// EXTERNAL MODULE: ./node_modules/@walletconnect/environment/dist/cjs/index.js
var environment_dist_cjs = __webpack_require__(25682);
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/env.js

const isNodeJs = (/* unused pure expression or super */ null && (isNode));

//# sourceMappingURL=env.js.map
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/format.js


function payloadId(entropy = 3) {
    const date = Date.now() * Math.pow(10, entropy);
    const extra = Math.floor(Math.random() * Math.pow(10, entropy));
    return date + extra;
}
function getBigIntRpcId(entropy = 6) {
    return BigInt(payloadId(entropy));
}
function formatJsonRpcRequest(method, params, id) {
    return {
        id: id || payloadId(),
        jsonrpc: "2.0",
        method,
        params,
    };
}
function formatJsonRpcResult(id, result) {
    return {
        id,
        jsonrpc: "2.0",
        result,
    };
}
function formatJsonRpcError(id, error, data) {
    return {
        id,
        jsonrpc: "2.0",
        error: formatErrorMessage(error, data),
    };
}
function formatErrorMessage(error, data) {
    if (typeof error === "undefined") {
        return getError(INTERNAL_ERROR);
    }
    if (typeof error === "string") {
        error = Object.assign(Object.assign({}, getError(SERVER_ERROR)), { message: error });
    }
    if (typeof data !== "undefined") {
        error.data = data;
    }
    if (isReservedErrorCode(error.code)) {
        error = getErrorByCode(error.code);
    }
    return error;
}
//# sourceMappingURL=format.js.map
;// ./node_modules/@walletconnect/jsonrpc-types/dist/index.es.js
class dist_index_es_e{}class dist_index_es_o extends dist_index_es_e{constructor(c){super()}}class jsonrpc_types_dist_index_es_n extends dist_index_es_e{constructor(){super()}}class dist_index_es_r extends jsonrpc_types_dist_index_es_n{constructor(c){super()}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/types.js

//# sourceMappingURL=types.js.map
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/url.js
const HTTP_REGEX = "^https?:";
const WS_REGEX = "^wss?:";
function getUrlProtocol(url) {
    const matches = url.match(new RegExp(/^\w+:/, "gi"));
    if (!matches || !matches.length)
        return;
    return matches[0];
}
function matchRegexProtocol(url, regex) {
    const protocol = getUrlProtocol(url);
    if (typeof protocol === "undefined")
        return false;
    return new RegExp(regex).test(protocol);
}
function isHttpUrl(url) {
    return matchRegexProtocol(url, HTTP_REGEX);
}
function isWsUrl(url) {
    return matchRegexProtocol(url, WS_REGEX);
}
function isLocalhostUrl(url) {
    return new RegExp("wss?://localhost(:d{2,5})?").test(url);
}
//# sourceMappingURL=url.js.map
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/validators.js
function isJsonRpcPayload(payload) {
    return (typeof payload === "object" &&
        "id" in payload &&
        "jsonrpc" in payload &&
        payload.jsonrpc === "2.0");
}
function isJsonRpcRequest(payload) {
    return isJsonRpcPayload(payload) && "method" in payload;
}
function isJsonRpcResponse(payload) {
    return isJsonRpcPayload(payload) && (isJsonRpcResult(payload) || isJsonRpcError(payload));
}
function isJsonRpcResult(payload) {
    return "result" in payload;
}
function isJsonRpcError(payload) {
    return "error" in payload;
}
function isJsonRpcValidationInvalid(validation) {
    return "error" in validation && validation.valid === false;
}
//# sourceMappingURL=validators.js.map
;// ./node_modules/@walletconnect/jsonrpc-utils/dist/esm/index.js








//# sourceMappingURL=index.js.map
;// ./node_modules/@walletconnect/jsonrpc-provider/dist/index.es.js
class jsonrpc_provider_dist_index_es_o extends dist_index_es_r{constructor(t){super(t),this.events=new external_events_.EventEmitter,this.hasRegisteredEventListeners=!1,this.connection=this.setConnection(t),this.connection.connected&&this.registerEventListeners()}async connect(t=this.connection){await this.open(t)}async disconnect(){await this.close()}on(t,e){this.events.on(t,e)}once(t,e){this.events.once(t,e)}off(t,e){this.events.off(t,e)}removeListener(t,e){this.events.removeListener(t,e)}async request(t,e){return this.requestStrict(formatJsonRpcRequest(t.method,t.params||[],t.id||getBigIntRpcId().toString()),e)}async requestStrict(t,e){return new Promise(async(i,s)=>{if(!this.connection.connected)try{await this.open()}catch(n){s(n)}this.events.on(`${t.id}`,n=>{isJsonRpcError(n)?s(n.error):i(n.result)});try{await this.connection.send(t,e)}catch(n){s(n)}})}setConnection(t=this.connection){return t}onPayload(t){this.events.emit("payload",t),isJsonRpcResponse(t)?this.events.emit(`${t.id}`,t):this.events.emit("message",{type:t.method,data:t.params})}onClose(t){t&&t.code===3e3&&this.events.emit("error",new Error(`WebSocket connection closed abnormally with code: ${t.code} ${t.reason?`(${t.reason})`:""}`)),this.events.emit("disconnect")}async open(t=this.connection){this.connection===t&&this.connection.connected||(this.connection.connected&&this.close(),typeof t=="string"&&(await this.connection.open(t),t=this.connection),this.connection=this.setConnection(t),await this.connection.open(),this.registerEventListeners(),this.events.emit("connect"))}async close(){await this.connection.close()}registerEventListeners(){this.hasRegisteredEventListeners||(this.connection.on("payload",t=>this.onPayload(t)),this.connection.on("close",t=>this.onClose(t)),this.connection.on("error",t=>this.events.emit("error",t)),this.connection.on("register_error",t=>this.onClose()),this.hasRegisteredEventListeners=!0)}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/jsonrpc-ws-connection/dist/index.es.js
const dist_index_es_v=()=>typeof WebSocket<"u"?WebSocket:typeof global<"u"&&typeof global.WebSocket<"u"?global.WebSocket:typeof window<"u"&&typeof window.WebSocket<"u"?window.WebSocket:typeof self<"u"&&typeof self.WebSocket<"u"?self.WebSocket:__webpack_require__(92784),jsonrpc_ws_connection_dist_index_es_w=()=>typeof WebSocket<"u"||typeof global<"u"&&typeof global.WebSocket<"u"||typeof window<"u"&&typeof window.WebSocket<"u"||typeof self<"u"&&typeof self.WebSocket<"u",jsonrpc_ws_connection_dist_index_es_d=r=>r.split("?")[0],jsonrpc_ws_connection_dist_index_es_h=10,jsonrpc_ws_connection_dist_index_es_b=dist_index_es_v();class jsonrpc_ws_connection_dist_index_es_f{constructor(e){if(this.url=e,this.events=new external_events_.EventEmitter,this.registering=!1,!isWsUrl(e))throw new Error(`Provided URL is not compatible with WebSocket connection: ${e}`);this.url=e}get connected(){return typeof this.socket<"u"}get connecting(){return this.registering}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeListener(e,t){this.events.removeListener(e,t)}async open(e=this.url){await this.register(e)}async close(){return new Promise((e,t)=>{if(typeof this.socket>"u"){t(new Error("Connection already closed"));return}this.socket.onclose=n=>{this.onClose(n),e()},this.socket.close()})}async send(e){typeof this.socket>"u"&&(this.socket=await this.register());try{this.socket.send(safeJsonStringify(e))}catch(t){this.onError(e.id,t)}}register(e=this.url){if(!isWsUrl(e))throw new Error(`Provided URL is not compatible with WebSocket connection: ${e}`);if(this.registering){const t=this.events.getMaxListeners();return(this.events.listenerCount("register_error")>=t||this.events.listenerCount("open")>=t)&&this.events.setMaxListeners(t+1),new Promise((n,s)=>{this.events.once("register_error",o=>{this.resetMaxListeners(),s(o)}),this.events.once("open",()=>{if(this.resetMaxListeners(),typeof this.socket>"u")return s(new Error("WebSocket connection is missing or invalid"));n(this.socket)})})}return this.url=e,this.registering=!0,new Promise((t,n)=>{const s=(0,environment_dist_cjs.isReactNative)()?void 0:{rejectUnauthorized:!isLocalhostUrl(e)},o=new jsonrpc_ws_connection_dist_index_es_b(e,[],s);jsonrpc_ws_connection_dist_index_es_w()?o.onerror=i=>{const a=i;n(this.emitError(a.error))}:o.on("error",i=>{n(this.emitError(i))}),o.onopen=()=>{this.onOpen(o),t(o)}})}onOpen(e){e.onmessage=t=>this.onPayload(t),e.onclose=t=>this.onClose(t),this.socket=e,this.registering=!1,this.events.emit("open")}onClose(e){this.socket=void 0,this.registering=!1,this.events.emit("close",e)}onPayload(e){if(typeof e.data>"u")return;const t=typeof e.data=="string"?safeJsonParse(e.data):e.data;this.events.emit("payload",t)}onError(e,t){const n=this.parseError(t),s=n.message||n.toString(),o=formatJsonRpcError(e,s);this.events.emit("payload",o)}parseError(e,t=this.url){return parseConnectionError(e,jsonrpc_ws_connection_dist_index_es_d(t),"WS")}resetMaxListeners(){this.events.getMaxListeners()>jsonrpc_ws_connection_dist_index_es_h&&this.events.setMaxListeners(jsonrpc_ws_connection_dist_index_es_h)}emitError(e){const t=this.parseError(new Error(e?.message||`WebSocket connection failed for host: ${jsonrpc_ws_connection_dist_index_es_d(this.url)}`));return this.events.emit("register_error",t),t}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/core/dist/index.es.js
const index_es_ze="wc",dist_index_es_Le=2,index_es_he="core",index_es_B=`${index_es_ze}@2:${index_es_he}:`,dist_index_es_Et={name:index_es_he,logger:"error"},dist_index_es_It={database:":memory:"},dist_index_es_Tt="crypto",dist_index_es_ke="client_ed25519_seed",Ct=cjs.ONE_DAY,dist_index_es_Pt="keychain",dist_index_es_St="0.3",dist_index_es_Rt="messages",dist_index_es_Ot="0.3",dist_index_es_je=cjs.SIX_HOURS,index_es_At="publisher",dist_index_es_xt="irn",dist_index_es_Nt="error",dist_index_es_Ue="wss://relay.walletconnect.org",dist_index_es_$t="relayer",core_dist_index_es_C={message:"relayer_message",message_ack:"relayer_message_ack",connect:"relayer_connect",disconnect:"relayer_disconnect",error:"relayer_error",connection_stalled:"relayer_connection_stalled",transport_closed:"relayer_transport_closed",publish:"relayer_publish"},dist_index_es_zt="_subscription",index_es_L={payload:"payload",connect:"connect",disconnect:"disconnect",error:"error"},dist_index_es_Lt=.1,index_es_qs={database:":memory:"},core_dist_index_es_e="2.19.1",index_es_Gs=1e4,dist_index_es_Q={link_mode:"link_mode",relay:"relay"},dist_index_es_le={inbound:"inbound",outbound:"outbound"},dist_index_es_kt="0.3",index_es_jt="WALLETCONNECT_CLIENT_ID",dist_index_es_Me="WALLETCONNECT_LINK_MODE_APPS",index_es_$={created:"subscription_created",deleted:"subscription_deleted",expired:"subscription_expired",disabled:"subscription_disabled",sync:"subscription_sync",resubscribed:"subscription_resubscribed"},index_es_Ws=(/* unused pure expression or super */ null && (Ce)),dist_index_es_Ut="subscription",dist_index_es_Mt="0.3",index_es_Hs=cjs.FIVE_SECONDS*1e3,dist_index_es_Ft="pairing",dist_index_es_Kt="0.3",index_es_Ys=(/* unused pure expression or super */ null && (Ce)),index_es_ie={wc_pairingDelete:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:1e3},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:1001}},wc_pairingPing:{req:{ttl:cjs.THIRTY_SECONDS,prompt:!1,tag:1002},res:{ttl:cjs.THIRTY_SECONDS,prompt:!1,tag:1003}},unregistered_method:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:0},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:0}}},index_es_se={create:"pairing_create",expire:"pairing_expire",delete:"pairing_delete",ping:"pairing_ping"},core_dist_index_es_M={created:"history_created",updated:"history_updated",deleted:"history_deleted",sync:"history_sync"},dist_index_es_Bt="history",dist_index_es_Vt="0.3",dist_index_es_qt="expirer",index_es_F={created:"expirer_created",deleted:"expirer_deleted",expired:"expirer_expired",sync:"expirer_sync"},dist_index_es_Gt="0.3",index_es_Js=(/* unused pure expression or super */ null && (te)),dist_index_es_Wt="verify-api",index_es_Xs="https://verify.walletconnect.com",dist_index_es_Ht="https://verify.walletconnect.org",index_es_ue=dist_index_es_Ht,dist_index_es_Yt=`${index_es_ue}/v3`,dist_index_es_Jt=[index_es_Xs,dist_index_es_Ht],dist_index_es_Xt="echo",dist_index_es_Zt="https://echo.walletconnect.com",index_es_Zs="event-client",index_es_G={pairing_started:"pairing_started",pairing_uri_validation_success:"pairing_uri_validation_success",pairing_uri_not_expired:"pairing_uri_not_expired",store_new_pairing:"store_new_pairing",subscribing_pairing_topic:"subscribing_pairing_topic",subscribe_pairing_topic_success:"subscribe_pairing_topic_success",existing_pairing:"existing_pairing",pairing_not_expired:"pairing_not_expired",emit_inactive_pairing:"emit_inactive_pairing",emit_session_proposal:"emit_session_proposal",subscribing_to_pairing_topic:"subscribing_to_pairing_topic"},index_es_Y={no_wss_connection:"no_wss_connection",no_internet_connection:"no_internet_connection",malformed_pairing_uri:"malformed_pairing_uri",active_pairing_already_exists:"active_pairing_already_exists",subscribe_pairing_topic_failure:"subscribe_pairing_topic_failure",pairing_expired:"pairing_expired",proposal_expired:"proposal_expired",proposal_listener_not_found:"proposal_listener_not_found"},index_es_Qs={session_approve_started:"session_approve_started",proposal_not_expired:"proposal_not_expired",session_namespaces_validation_success:"session_namespaces_validation_success",create_session_topic:"create_session_topic",subscribing_session_topic:"subscribing_session_topic",subscribe_session_topic_success:"subscribe_session_topic_success",publishing_session_approve:"publishing_session_approve",session_approve_publish_success:"session_approve_publish_success",store_session:"store_session",publishing_session_settle:"publishing_session_settle",session_settle_publish_success:"session_settle_publish_success"},dist_index_es_er={no_internet_connection:"no_internet_connection",no_wss_connection:"no_wss_connection",proposal_expired:"proposal_expired",subscribe_session_topic_failure:"subscribe_session_topic_failure",session_approve_publish_failure:"session_approve_publish_failure",session_settle_publish_failure:"session_settle_publish_failure",session_approve_namespace_validation_failure:"session_approve_namespace_validation_failure",proposal_not_found:"proposal_not_found"},dist_index_es_tr={authenticated_session_approve_started:"authenticated_session_approve_started",authenticated_session_not_expired:"authenticated_session_not_expired",chains_caip2_compliant:"chains_caip2_compliant",chains_evm_compliant:"chains_evm_compliant",create_authenticated_session_topic:"create_authenticated_session_topic",cacaos_verified:"cacaos_verified",store_authenticated_session:"store_authenticated_session",subscribing_authenticated_session_topic:"subscribing_authenticated_session_topic",subscribe_authenticated_session_topic_success:"subscribe_authenticated_session_topic_success",publishing_authenticated_session_approve:"publishing_authenticated_session_approve",authenticated_session_approve_publish_success:"authenticated_session_approve_publish_success"},dist_index_es_ir={no_internet_connection:"no_internet_connection",no_wss_connection:"no_wss_connection",missing_session_authenticate_request:"missing_session_authenticate_request",session_authenticate_request_expired:"session_authenticate_request_expired",chains_caip2_compliant_failure:"chains_caip2_compliant_failure",chains_evm_compliant_failure:"chains_evm_compliant_failure",invalid_cacao:"invalid_cacao",subscribe_authenticated_session_topic_failure:"subscribe_authenticated_session_topic_failure",authenticated_session_approve_publish_failure:"authenticated_session_approve_publish_failure",authenticated_session_pending_request_not_found:"authenticated_session_pending_request_not_found"},dist_index_es_Qt=.1,index_es_ei="event-client",index_es_ti=86400,index_es_ii="https://pulse.walletconnect.org/batch";function dist_index_es_sr(r,e){if(r.length>=255)throw new TypeError("Alphabet too long");for(var t=new Uint8Array(256),s=0;s<t.length;s++)t[s]=255;for(var i=0;i<r.length;i++){var n=r.charAt(i),o=n.charCodeAt(0);if(t[o]!==255)throw new TypeError(n+" is ambiguous");t[o]=i}var a=r.length,c=r.charAt(0),h=Math.log(a)/Math.log(256),u=Math.log(256)/Math.log(a);function d(l){if(l instanceof Uint8Array||(ArrayBuffer.isView(l)?l=new Uint8Array(l.buffer,l.byteOffset,l.byteLength):Array.isArray(l)&&(l=Uint8Array.from(l))),!(l instanceof Uint8Array))throw new TypeError("Expected Uint8Array");if(l.length===0)return"";for(var b=0,x=0,I=0,D=l.length;I!==D&&l[I]===0;)I++,b++;for(var j=(D-I)*u+1>>>0,T=new Uint8Array(j);I!==D;){for(var q=l[I],J=0,K=j-1;(q!==0||J<x)&&K!==-1;K--,J++)q+=256*T[K]>>>0,T[K]=q%a>>>0,q=q/a>>>0;if(q!==0)throw new Error("Non-zero carry");x=J,I++}for(var H=j-x;H!==j&&T[H]===0;)H++;for(var me=c.repeat(b);H<j;++H)me+=r.charAt(T[H]);return me}function g(l){if(typeof l!="string")throw new TypeError("Expected String");if(l.length===0)return new Uint8Array;var b=0;if(l[b]!==" "){for(var x=0,I=0;l[b]===c;)x++,b++;for(var D=(l.length-b)*h+1>>>0,j=new Uint8Array(D);l[b];){var T=t[l.charCodeAt(b)];if(T===255)return;for(var q=0,J=D-1;(T!==0||q<I)&&J!==-1;J--,q++)T+=a*j[J]>>>0,j[J]=T%256>>>0,T=T/256>>>0;if(T!==0)throw new Error("Non-zero carry");I=q,b++}if(l[b]!==" "){for(var K=D-I;K!==D&&j[K]===0;)K++;for(var H=new Uint8Array(x+(D-K)),me=x;K!==D;)H[me++]=j[K++];return H}}}function _(l){var b=g(l);if(b)return b;throw new Error(`Non-${e} character`)}return{encode:d,decodeUnsafe:g,decode:_}}var dist_index_es_rr=dist_index_es_sr,dist_index_es_nr=dist_index_es_rr;const index_es_si=r=>{if(r instanceof Uint8Array&&r.constructor.name==="Uint8Array")return r;if(r instanceof ArrayBuffer)return new Uint8Array(r);if(ArrayBuffer.isView(r))return new Uint8Array(r.buffer,r.byteOffset,r.byteLength);throw new Error("Unknown type, must be binary type")},dist_index_es_or=r=>new TextEncoder().encode(r),dist_index_es_ar=r=>new TextDecoder().decode(r);class dist_index_es_cr{constructor(e,t,s){this.name=e,this.prefix=t,this.baseEncode=s}encode(e){if(e instanceof Uint8Array)return`${this.prefix}${this.baseEncode(e)}`;throw Error("Unknown type, must be binary type")}}class dist_index_es_hr{constructor(e,t,s){if(this.name=e,this.prefix=t,t.codePointAt(0)===void 0)throw new Error("Invalid prefix character");this.prefixCodePoint=t.codePointAt(0),this.baseDecode=s}decode(e){if(typeof e=="string"){if(e.codePointAt(0)!==this.prefixCodePoint)throw Error(`Unable to decode multibase string ${JSON.stringify(e)}, ${this.name} decoder only supports inputs prefixed with ${this.prefix}`);return this.baseDecode(e.slice(this.prefix.length))}else throw Error("Can only multibase decode strings")}or(e){return index_es_ri(this,e)}}class dist_index_es_lr{constructor(e){this.decoders=e}or(e){return index_es_ri(this,e)}decode(e){const t=e[0],s=this.decoders[t];if(s)return s.decode(e);throw RangeError(`Unable to decode multibase string ${JSON.stringify(e)}, only inputs prefixed with ${Object.keys(this.decoders)} are supported`)}}const index_es_ri=(r,e)=>new dist_index_es_lr({...r.decoders||{[r.prefix]:r},...e.decoders||{[e.prefix]:e}});class dist_index_es_ur{constructor(e,t,s,i){this.name=e,this.prefix=t,this.baseEncode=s,this.baseDecode=i,this.encoder=new dist_index_es_cr(e,t,s),this.decoder=new dist_index_es_hr(e,t,i)}encode(e){return this.encoder.encode(e)}decode(e){return this.decoder.decode(e)}}const dist_index_es_Ee=({name:r,prefix:e,encode:t,decode:s})=>new dist_index_es_ur(r,e,t,s),dist_index_es_de=({prefix:r,name:e,alphabet:t})=>{const{encode:s,decode:i}=dist_index_es_nr(t,e);return dist_index_es_Ee({prefix:r,name:e,encode:s,decode:n=>index_es_si(i(n))})},dist_index_es_dr=(r,e,t,s)=>{const i={};for(let u=0;u<e.length;++u)i[e[u]]=u;let n=r.length;for(;r[n-1]==="=";)--n;const o=new Uint8Array(n*t/8|0);let a=0,c=0,h=0;for(let u=0;u<n;++u){const d=i[r[u]];if(d===void 0)throw new SyntaxError(`Non-${s} character`);c=c<<t|d,a+=t,a>=8&&(a-=8,o[h++]=255&c>>a)}if(a>=t||255&c<<8-a)throw new SyntaxError("Unexpected end of data");return o},dist_index_es_gr=(r,e,t)=>{const s=e[e.length-1]==="=",i=(1<<t)-1;let n="",o=0,a=0;for(let c=0;c<r.length;++c)for(a=a<<8|r[c],o+=8;o>t;)o-=t,n+=e[i&a>>o];if(o&&(n+=e[i&a<<t-o]),s)for(;n.length*t&7;)n+="=";return n},core_dist_index_es_P=({name:r,prefix:e,bitsPerChar:t,alphabet:s})=>dist_index_es_Ee({prefix:e,name:r,encode(i){return dist_index_es_gr(i,s,t)},decode(i){return dist_index_es_dr(i,s,t,r)}}),dist_index_es_pr=dist_index_es_Ee({prefix:"\0",name:"identity",encode:r=>dist_index_es_ar(r),decode:r=>dist_index_es_or(r)});var dist_index_es_yr=Object.freeze({__proto__:null,identity:dist_index_es_pr});const dist_index_es_br=core_dist_index_es_P({prefix:"0",name:"base2",alphabet:"01",bitsPerChar:1});var dist_index_es_mr=Object.freeze({__proto__:null,base2:dist_index_es_br});const dist_index_es_fr=core_dist_index_es_P({prefix:"7",name:"base8",alphabet:"01234567",bitsPerChar:3});var index_es_Dr=Object.freeze({__proto__:null,base8:dist_index_es_fr});const dist_index_es_vr=dist_index_es_de({prefix:"9",name:"base10",alphabet:"0123456789"});var dist_index_es_wr=Object.freeze({__proto__:null,base10:dist_index_es_vr});const core_dist_index_es_r=core_dist_index_es_P({prefix:"f",name:"base16",alphabet:"0123456789abcdef",bitsPerChar:4}),dist_index_es_Er=core_dist_index_es_P({prefix:"F",name:"base16upper",alphabet:"0123456789ABCDEF",bitsPerChar:4});var dist_index_es_Ir=Object.freeze({__proto__:null,base16:core_dist_index_es_r,base16upper:dist_index_es_Er});const dist_index_es_Tr=core_dist_index_es_P({prefix:"b",name:"base32",alphabet:"abcdefghijklmnopqrstuvwxyz234567",bitsPerChar:5}),index_es_Cr=core_dist_index_es_P({prefix:"B",name:"base32upper",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",bitsPerChar:5}),index_es_Pr=core_dist_index_es_P({prefix:"c",name:"base32pad",alphabet:"abcdefghijklmnopqrstuvwxyz234567=",bitsPerChar:5}),dist_index_es_Sr=core_dist_index_es_P({prefix:"C",name:"base32padupper",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",bitsPerChar:5}),dist_index_es_Rr=core_dist_index_es_P({prefix:"v",name:"base32hex",alphabet:"0123456789abcdefghijklmnopqrstuv",bitsPerChar:5}),dist_index_es_Or=core_dist_index_es_P({prefix:"V",name:"base32hexupper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUV",bitsPerChar:5}),dist_index_es_Ar=core_dist_index_es_P({prefix:"t",name:"base32hexpad",alphabet:"0123456789abcdefghijklmnopqrstuv=",bitsPerChar:5}),dist_index_es_xr=core_dist_index_es_P({prefix:"T",name:"base32hexpadupper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUV=",bitsPerChar:5}),dist_index_es_Nr=core_dist_index_es_P({prefix:"h",name:"base32z",alphabet:"ybndrfg8ejkmcpqxot1uwisza345h769",bitsPerChar:5});var dist_index_es_$r=Object.freeze({__proto__:null,base32:dist_index_es_Tr,base32upper:index_es_Cr,base32pad:index_es_Pr,base32padupper:dist_index_es_Sr,base32hex:dist_index_es_Rr,base32hexupper:dist_index_es_Or,base32hexpad:dist_index_es_Ar,base32hexpadupper:dist_index_es_xr,base32z:dist_index_es_Nr});const dist_index_es_zr=dist_index_es_de({prefix:"k",name:"base36",alphabet:"0123456789abcdefghijklmnopqrstuvwxyz"}),index_es_Lr=dist_index_es_de({prefix:"K",name:"base36upper",alphabet:"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"});var index_es_kr=Object.freeze({__proto__:null,base36:dist_index_es_zr,base36upper:index_es_Lr});const index_es_jr=dist_index_es_de({name:"base58btc",prefix:"z",alphabet:"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"}),dist_index_es_Ur=dist_index_es_de({name:"base58flickr",prefix:"Z",alphabet:"123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"});var index_es_Mr=Object.freeze({__proto__:null,base58btc:index_es_jr,base58flickr:dist_index_es_Ur});const dist_index_es_Fr=core_dist_index_es_P({prefix:"m",name:"base64",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",bitsPerChar:6}),dist_index_es_Kr=core_dist_index_es_P({prefix:"M",name:"base64pad",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",bitsPerChar:6}),index_es_Br=core_dist_index_es_P({prefix:"u",name:"base64url",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",bitsPerChar:6}),dist_index_es_Vr=core_dist_index_es_P({prefix:"U",name:"base64urlpad",alphabet:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=",bitsPerChar:6});var dist_index_es_qr=Object.freeze({__proto__:null,base64:dist_index_es_Fr,base64pad:dist_index_es_Kr,base64url:index_es_Br,base64urlpad:dist_index_es_Vr});const index_es_ni=Array.from("\u{1F680}\u{1FA90}\u2604\u{1F6F0}\u{1F30C}\u{1F311}\u{1F312}\u{1F313}\u{1F314}\u{1F315}\u{1F316}\u{1F317}\u{1F318}\u{1F30D}\u{1F30F}\u{1F30E}\u{1F409}\u2600\u{1F4BB}\u{1F5A5}\u{1F4BE}\u{1F4BF}\u{1F602}\u2764\u{1F60D}\u{1F923}\u{1F60A}\u{1F64F}\u{1F495}\u{1F62D}\u{1F618}\u{1F44D}\u{1F605}\u{1F44F}\u{1F601}\u{1F525}\u{1F970}\u{1F494}\u{1F496}\u{1F499}\u{1F622}\u{1F914}\u{1F606}\u{1F644}\u{1F4AA}\u{1F609}\u263A\u{1F44C}\u{1F917}\u{1F49C}\u{1F614}\u{1F60E}\u{1F607}\u{1F339}\u{1F926}\u{1F389}\u{1F49E}\u270C\u2728\u{1F937}\u{1F631}\u{1F60C}\u{1F338}\u{1F64C}\u{1F60B}\u{1F497}\u{1F49A}\u{1F60F}\u{1F49B}\u{1F642}\u{1F493}\u{1F929}\u{1F604}\u{1F600}\u{1F5A4}\u{1F603}\u{1F4AF}\u{1F648}\u{1F447}\u{1F3B6}\u{1F612}\u{1F92D}\u2763\u{1F61C}\u{1F48B}\u{1F440}\u{1F62A}\u{1F611}\u{1F4A5}\u{1F64B}\u{1F61E}\u{1F629}\u{1F621}\u{1F92A}\u{1F44A}\u{1F973}\u{1F625}\u{1F924}\u{1F449}\u{1F483}\u{1F633}\u270B\u{1F61A}\u{1F61D}\u{1F634}\u{1F31F}\u{1F62C}\u{1F643}\u{1F340}\u{1F337}\u{1F63B}\u{1F613}\u2B50\u2705\u{1F97A}\u{1F308}\u{1F608}\u{1F918}\u{1F4A6}\u2714\u{1F623}\u{1F3C3}\u{1F490}\u2639\u{1F38A}\u{1F498}\u{1F620}\u261D\u{1F615}\u{1F33A}\u{1F382}\u{1F33B}\u{1F610}\u{1F595}\u{1F49D}\u{1F64A}\u{1F639}\u{1F5E3}\u{1F4AB}\u{1F480}\u{1F451}\u{1F3B5}\u{1F91E}\u{1F61B}\u{1F534}\u{1F624}\u{1F33C}\u{1F62B}\u26BD\u{1F919}\u2615\u{1F3C6}\u{1F92B}\u{1F448}\u{1F62E}\u{1F646}\u{1F37B}\u{1F343}\u{1F436}\u{1F481}\u{1F632}\u{1F33F}\u{1F9E1}\u{1F381}\u26A1\u{1F31E}\u{1F388}\u274C\u270A\u{1F44B}\u{1F630}\u{1F928}\u{1F636}\u{1F91D}\u{1F6B6}\u{1F4B0}\u{1F353}\u{1F4A2}\u{1F91F}\u{1F641}\u{1F6A8}\u{1F4A8}\u{1F92C}\u2708\u{1F380}\u{1F37A}\u{1F913}\u{1F619}\u{1F49F}\u{1F331}\u{1F616}\u{1F476}\u{1F974}\u25B6\u27A1\u2753\u{1F48E}\u{1F4B8}\u2B07\u{1F628}\u{1F31A}\u{1F98B}\u{1F637}\u{1F57A}\u26A0\u{1F645}\u{1F61F}\u{1F635}\u{1F44E}\u{1F932}\u{1F920}\u{1F927}\u{1F4CC}\u{1F535}\u{1F485}\u{1F9D0}\u{1F43E}\u{1F352}\u{1F617}\u{1F911}\u{1F30A}\u{1F92F}\u{1F437}\u260E\u{1F4A7}\u{1F62F}\u{1F486}\u{1F446}\u{1F3A4}\u{1F647}\u{1F351}\u2744\u{1F334}\u{1F4A3}\u{1F438}\u{1F48C}\u{1F4CD}\u{1F940}\u{1F922}\u{1F445}\u{1F4A1}\u{1F4A9}\u{1F450}\u{1F4F8}\u{1F47B}\u{1F910}\u{1F92E}\u{1F3BC}\u{1F975}\u{1F6A9}\u{1F34E}\u{1F34A}\u{1F47C}\u{1F48D}\u{1F4E3}\u{1F942}"),dist_index_es_Gr=index_es_ni.reduce((r,e,t)=>(r[t]=e,r),[]),dist_index_es_Wr=index_es_ni.reduce((r,e,t)=>(r[e.codePointAt(0)]=t,r),[]);function dist_index_es_Hr(r){return r.reduce((e,t)=>(e+=dist_index_es_Gr[t],e),"")}function dist_index_es_Yr(r){const e=[];for(const t of r){const s=dist_index_es_Wr[t.codePointAt(0)];if(s===void 0)throw new Error(`Non-base256emoji character: ${t}`);e.push(s)}return new Uint8Array(e)}const dist_index_es_Jr=dist_index_es_Ee({prefix:"\u{1F680}",name:"base256emoji",encode:dist_index_es_Hr,decode:dist_index_es_Yr});var dist_index_es_Xr=Object.freeze({__proto__:null,base256emoji:dist_index_es_Jr}),dist_index_es_Zr=index_es_ai,index_es_oi=128,dist_index_es_Qr=127,dist_index_es_en=~dist_index_es_Qr,dist_index_es_tn=Math.pow(2,31);function index_es_ai(r,e,t){e=e||[],t=t||0;for(var s=t;r>=dist_index_es_tn;)e[t++]=r&255|index_es_oi,r/=128;for(;r&dist_index_es_en;)e[t++]=r&255|index_es_oi,r>>>=7;return e[t]=r|0,index_es_ai.bytes=t-s+1,e}var dist_index_es_sn=dist_index_es_Fe,dist_index_es_rn=128,index_es_ci=127;function dist_index_es_Fe(r,s){var t=0,s=s||0,i=0,n=s,o,a=r.length;do{if(n>=a)throw dist_index_es_Fe.bytes=0,new RangeError("Could not decode varint");o=r[n++],t+=i<28?(o&index_es_ci)<<i:(o&index_es_ci)*Math.pow(2,i),i+=7}while(o>=dist_index_es_rn);return dist_index_es_Fe.bytes=n-s,t}var dist_index_es_nn=Math.pow(2,7),dist_index_es_on=Math.pow(2,14),index_es_an=Math.pow(2,21),index_es_cn=Math.pow(2,28),index_es_hn=Math.pow(2,35),index_es_ln=Math.pow(2,42),index_es_un=Math.pow(2,49),index_es_dn=Math.pow(2,56),dist_index_es_gn=Math.pow(2,63),index_es_pn=function(r){return r<dist_index_es_nn?1:r<dist_index_es_on?2:r<index_es_an?3:r<index_es_cn?4:r<index_es_hn?5:r<index_es_ln?6:r<index_es_un?7:r<index_es_dn?8:r<dist_index_es_gn?9:10},dist_index_es_yn={encode:dist_index_es_Zr,decode:dist_index_es_sn,encodingLength:index_es_pn},index_es_hi=dist_index_es_yn;const index_es_li=(r,e,t=0)=>(index_es_hi.encode(r,e,t),e),index_es_ui=r=>index_es_hi.encodingLength(r),dist_index_es_Ke=(r,e)=>{const t=e.byteLength,s=index_es_ui(r),i=s+index_es_ui(t),n=new Uint8Array(i+t);return index_es_li(r,n,0),index_es_li(t,n,s),n.set(e,i),new index_es_bn(r,t,e,n)};class index_es_bn{constructor(e,t,s,i){this.code=e,this.size=t,this.digest=s,this.bytes=i}}const index_es_di=({name:r,code:e,encode:t})=>new dist_index_es_mn(r,e,t);class dist_index_es_mn{constructor(e,t,s){this.name=e,this.code=t,this.encode=s}digest(e){if(e instanceof Uint8Array){const t=this.encode(e);return t instanceof Uint8Array?dist_index_es_Ke(this.code,t):t.then(s=>dist_index_es_Ke(this.code,s))}else throw Error("Unknown type, must be binary type")}}const index_es_gi=r=>async e=>new Uint8Array(await crypto.subtle.digest(r,e)),index_es_fn=index_es_di({name:"sha2-256",code:18,encode:index_es_gi("SHA-256")}),index_es_Dn=index_es_di({name:"sha2-512",code:19,encode:index_es_gi("SHA-512")});var dist_index_es_vn=Object.freeze({__proto__:null,sha256:index_es_fn,sha512:index_es_Dn});const index_es_pi=0,index_es_wn="identity",index_es_yi=index_es_si,core_dist_index_es_n=r=>dist_index_es_Ke(index_es_pi,index_es_yi(r)),dist_index_es_En={code:index_es_pi,name:index_es_wn,encode:index_es_yi,digest:core_dist_index_es_n};var dist_index_es_In=Object.freeze({__proto__:null,identity:dist_index_es_En});new TextEncoder,new TextDecoder;const index_es_bi={...dist_index_es_yr,...dist_index_es_mr,...index_es_Dr,...dist_index_es_wr,...dist_index_es_Ir,...dist_index_es_$r,...index_es_kr,...index_es_Mr,...dist_index_es_qr,...dist_index_es_Xr};({...dist_index_es_vn,...dist_index_es_In});function dist_index_es_Tn(r=0){return globalThis.Buffer!=null&&globalThis.Buffer.allocUnsafe!=null?globalThis.Buffer.allocUnsafe(r):new Uint8Array(r)}function index_es_mi(r,e,t,s){return{name:r,prefix:e,encoder:{name:r,prefix:e,encode:t},decoder:{decode:s}}}const index_es_fi=index_es_mi("utf8","u",r=>"u"+new TextDecoder("utf8").decode(r),r=>new TextEncoder().encode(r.substring(1))),dist_index_es_Be=index_es_mi("ascii","a",r=>{let e="a";for(let t=0;t<r.length;t++)e+=String.fromCharCode(r[t]);return e},r=>{r=r.substring(1);const e=dist_index_es_Tn(r.length);for(let t=0;t<r.length;t++)e[t]=r.charCodeAt(t);return e}),dist_index_es_Cn={utf8:index_es_fi,"utf-8":index_es_fi,hex:index_es_bi.base16,latin1:dist_index_es_Be,ascii:dist_index_es_Be,binary:dist_index_es_Be,...index_es_bi};function dist_index_es_Pn(r,e="utf8"){const t=dist_index_es_Cn[e];if(!t)throw new Error(`Unsupported encoding "${e}"`);return(e==="utf8"||e==="utf-8")&&globalThis.Buffer!=null&&globalThis.Buffer.from!=null?globalThis.Buffer.from(r,"utf8"):t.decoder.decode(`${t.prefix}${r}`)}var dist_index_es_Sn=Object.defineProperty,dist_index_es_Rn=(r,e,t)=>e in r?dist_index_es_Sn(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_W=(r,e,t)=>dist_index_es_Rn(r,typeof e!="symbol"?e+"":e,t);class index_es_Di{constructor(e,t){this.core=e,this.logger=t,index_es_W(this,"keychain",new Map),index_es_W(this,"name",dist_index_es_Pt),index_es_W(this,"version",dist_index_es_St),index_es_W(this,"initialized",!1),index_es_W(this,"storagePrefix",index_es_B),index_es_W(this,"init",async()=>{if(!this.initialized){const s=await this.getKeyChain();typeof s<"u"&&(this.keychain=s),this.initialized=!0}}),index_es_W(this,"has",s=>(this.isInitialized(),this.keychain.has(s))),index_es_W(this,"set",async(s,i)=>{this.isInitialized(),this.keychain.set(s,i),await this.persist()}),index_es_W(this,"get",s=>{this.isInitialized();const i=this.keychain.get(s);if(typeof i>"u"){const{message:n}=dist_index_es_te("NO_MATCHING_KEY",`${this.name}: ${s}`);throw new Error(n)}return i}),index_es_W(this,"del",async s=>{this.isInitialized(),this.keychain.delete(s),await this.persist()}),this.core=e,this.logger=dist_index_es_E(t,this.name)}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name}async setKeyChain(e){await this.core.storage.setItem(this.storageKey,index_es_ro(e))}async getKeyChain(){const e=await this.core.storage.getItem(this.storageKey);return typeof e<"u"?index_es_oo(e):void 0}async persist(){await this.setKeyChain(this.keychain)}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_On=Object.defineProperty,dist_index_es_An=(r,e,t)=>e in r?dist_index_es_On(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,core_dist_index_es_S=(r,e,t)=>dist_index_es_An(r,typeof e!="symbol"?e+"":e,t);class index_es_vi{constructor(e,t,s){this.core=e,this.logger=t,core_dist_index_es_S(this,"name",dist_index_es_Tt),core_dist_index_es_S(this,"keychain"),core_dist_index_es_S(this,"randomSessionIdentifier",oi()),core_dist_index_es_S(this,"initialized",!1),core_dist_index_es_S(this,"init",async()=>{this.initialized||(await this.keychain.init(),this.initialized=!0)}),core_dist_index_es_S(this,"hasKeys",i=>(this.isInitialized(),this.keychain.has(i))),core_dist_index_es_S(this,"getClientId",async()=>{this.isInitialized();const i=await this.getClientSeed(),n=Po(i);return Qe(n.publicKey)}),core_dist_index_es_S(this,"generateKeyPair",()=>{this.isInitialized();const i=ri();return this.setPrivateKey(i.publicKey,i.privateKey)}),core_dist_index_es_S(this,"signJWT",async i=>{this.isInitialized();const n=await this.getClientSeed(),o=Po(n),a=this.randomSessionIdentifier,c=Ct;return await Qo(a,i,c,o)}),core_dist_index_es_S(this,"generateSharedKey",(i,n,o)=>{this.isInitialized();const a=this.getPrivateKey(i),c=si(a,n);return this.setSymKey(c,o)}),core_dist_index_es_S(this,"setSymKey",async(i,n)=>{this.isInitialized();const o=n||ii(i);return await this.keychain.set(o,i),o}),core_dist_index_es_S(this,"deleteKeyPair",async i=>{this.isInitialized(),await this.keychain.del(i)}),core_dist_index_es_S(this,"deleteSymKey",async i=>{this.isInitialized(),await this.keychain.del(i)}),core_dist_index_es_S(this,"encode",async(i,n,o)=>{this.isInitialized();const a=index_es_rr(o),c=safeJsonStringify(n);if(pi(a))return fi(c,o?.encoding);if(hi(a)){const g=a.senderPublicKey,_=a.receiverPublicKey;i=await this.generateSharedKey(g,_)}const h=this.getSymKey(i),{type:u,senderPublicKey:d}=a;return ai({type:u,symKey:h,message:c,senderPublicKey:d,encoding:o?.encoding})}),core_dist_index_es_S(this,"decode",async(i,n,o)=>{this.isInitialized();const a=di(n,o);if(pi(a)){const c=li(n,o?.encoding);return safeJsonParse(c)}if(hi(a)){const c=a.receiverPublicKey,h=a.senderPublicKey;i=await this.generateSharedKey(c,h)}try{const c=this.getSymKey(i),h=ui({symKey:c,encoded:n,encoding:o?.encoding});return safeJsonParse(h)}catch(c){this.logger.error(`Failed to decode message from topic: '${i}', clientId: '${await this.getClientId()}'`),this.logger.error(c)}}),core_dist_index_es_S(this,"getPayloadType",(i,n=At)=>{const o=index_es_Fe({encoded:i,encoding:n});return index_es_fe(o.type)}),core_dist_index_es_S(this,"getPayloadSenderPublicKey",(i,n=At)=>{const o=index_es_Fe({encoded:i,encoding:n});return o.senderPublicKey?to_string_toString(o.senderPublicKey,V):void 0}),this.core=e,this.logger=dist_index_es_E(t,this.name),this.keychain=s||new index_es_Di(this.core,this.logger)}get context(){return index_es_y(this.logger)}async setPrivateKey(e,t){return await this.keychain.set(e,t),e}getPrivateKey(e){return this.keychain.get(e)}async getClientSeed(){let e="";try{e=this.keychain.get(dist_index_es_ke)}catch{e=oi(),await this.keychain.set(dist_index_es_ke,e)}return dist_index_es_Pn(e,"base16")}getSymKey(e){return this.keychain.get(e)}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_xn=Object.defineProperty,dist_index_es_Nn=Object.defineProperties,dist_index_es_$n=Object.getOwnPropertyDescriptors,index_es_wi=Object.getOwnPropertySymbols,dist_index_es_zn=Object.prototype.hasOwnProperty,dist_index_es_Ln=Object.prototype.propertyIsEnumerable,dist_index_es_Ve=(r,e,t)=>e in r?dist_index_es_xn(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,dist_index_es_kn=(r,e)=>{for(var t in e||(e={}))dist_index_es_zn.call(e,t)&&dist_index_es_Ve(r,t,e[t]);if(index_es_wi)for(var t of index_es_wi(e))dist_index_es_Ln.call(e,t)&&dist_index_es_Ve(r,t,e[t]);return r},dist_index_es_jn=(r,e)=>dist_index_es_Nn(r,dist_index_es_$n(e)),core_dist_index_es_k=(r,e,t)=>dist_index_es_Ve(r,typeof e!="symbol"?e+"":e,t);class core_dist_index_es_i extends dist_index_es_y{constructor(e,t){super(e,t),this.logger=e,this.core=t,core_dist_index_es_k(this,"messages",new Map),core_dist_index_es_k(this,"messagesWithoutClientAck",new Map),core_dist_index_es_k(this,"name",dist_index_es_Rt),core_dist_index_es_k(this,"version",dist_index_es_Ot),core_dist_index_es_k(this,"initialized",!1),core_dist_index_es_k(this,"storagePrefix",index_es_B),core_dist_index_es_k(this,"init",async()=>{if(!this.initialized){this.logger.trace("Initialized");try{const s=await this.getRelayerMessages();typeof s<"u"&&(this.messages=s);const i=await this.getRelayerMessagesWithoutClientAck();typeof i<"u"&&(this.messagesWithoutClientAck=i),this.logger.debug(`Successfully Restored records for ${this.name}`),this.logger.trace({type:"method",method:"restore",size:this.messages.size})}catch(s){this.logger.debug(`Failed to Restore records for ${this.name}`),this.logger.error(s)}finally{this.initialized=!0}}}),core_dist_index_es_k(this,"set",async(s,i,n)=>{this.isInitialized();const o=ci(i);let a=this.messages.get(s);if(typeof a>"u"&&(a={}),typeof a[o]<"u")return o;if(a[o]=i,this.messages.set(s,a),n===dist_index_es_le.inbound){const c=this.messagesWithoutClientAck.get(s)||{};this.messagesWithoutClientAck.set(s,dist_index_es_jn(dist_index_es_kn({},c),{[o]:i}))}return await this.persist(),o}),core_dist_index_es_k(this,"get",s=>{this.isInitialized();let i=this.messages.get(s);return typeof i>"u"&&(i={}),i}),core_dist_index_es_k(this,"getWithoutAck",s=>{this.isInitialized();const i={};for(const n of s){const o=this.messagesWithoutClientAck.get(n)||{};i[n]=Object.values(o)}return i}),core_dist_index_es_k(this,"has",(s,i)=>{this.isInitialized();const n=this.get(s),o=ci(i);return typeof n[o]<"u"}),core_dist_index_es_k(this,"ack",async(s,i)=>{this.isInitialized();const n=this.messagesWithoutClientAck.get(s);if(typeof n>"u")return;const o=ci(i);delete n[o],Object.keys(n).length===0?this.messagesWithoutClientAck.delete(s):this.messagesWithoutClientAck.set(s,n),await this.persist()}),core_dist_index_es_k(this,"del",async s=>{this.isInitialized(),this.messages.delete(s),this.messagesWithoutClientAck.delete(s),await this.persist()}),this.logger=dist_index_es_E(e,this.name),this.core=t}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name}get storageKeyWithoutClientAck(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name+"_withoutClientAck"}async setRelayerMessages(e){await this.core.storage.setItem(this.storageKey,index_es_ro(e))}async setRelayerMessagesWithoutClientAck(e){await this.core.storage.setItem(this.storageKeyWithoutClientAck,index_es_ro(e))}async getRelayerMessages(){const e=await this.core.storage.getItem(this.storageKey);return typeof e<"u"?index_es_oo(e):void 0}async getRelayerMessagesWithoutClientAck(){const e=await this.core.storage.getItem(this.storageKeyWithoutClientAck);return typeof e<"u"?index_es_oo(e):void 0}async persist(){await this.setRelayerMessages(this.messages),await this.setRelayerMessagesWithoutClientAck(this.messagesWithoutClientAck)}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_Un=Object.defineProperty,dist_index_es_Mn=Object.defineProperties,dist_index_es_Fn=Object.getOwnPropertyDescriptors,index_es_Ei=Object.getOwnPropertySymbols,dist_index_es_Kn=Object.prototype.hasOwnProperty,dist_index_es_Bn=Object.prototype.propertyIsEnumerable,dist_index_es_qe=(r,e,t)=>e in r?dist_index_es_Un(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,dist_index_es_Ie=(r,e)=>{for(var t in e||(e={}))dist_index_es_Kn.call(e,t)&&dist_index_es_qe(r,t,e[t]);if(index_es_Ei)for(var t of index_es_Ei(e))dist_index_es_Bn.call(e,t)&&dist_index_es_qe(r,t,e[t]);return r},dist_index_es_Ge=(r,e)=>dist_index_es_Mn(r,dist_index_es_Fn(e)),dist_index_es_V=(r,e,t)=>dist_index_es_qe(r,typeof e!="symbol"?e+"":e,t);class dist_index_es_Vn extends dist_index_es_m{constructor(e,t){super(e,t),this.relayer=e,this.logger=t,dist_index_es_V(this,"events",new external_events_.EventEmitter),dist_index_es_V(this,"name",index_es_At),dist_index_es_V(this,"queue",new Map),dist_index_es_V(this,"publishTimeout",(0,cjs.toMiliseconds)(cjs.ONE_MINUTE)),dist_index_es_V(this,"initialPublishTimeout",(0,cjs.toMiliseconds)(cjs.ONE_SECOND*15)),dist_index_es_V(this,"needsTransportRestart",!1),dist_index_es_V(this,"publish",async(s,i,n)=>{var o;this.logger.debug("Publishing Payload"),this.logger.trace({type:"method",method:"publish",params:{topic:s,message:i,opts:n}});const a=n?.ttl||dist_index_es_je,c=bi(n),h=n?.prompt||!1,u=n?.tag||0,d=n?.id||getBigIntRpcId().toString(),g={topic:s,message:i,opts:{ttl:a,relay:c,prompt:h,tag:u,id:d,attestation:n?.attestation,tvf:n?.tvf}},_=`Failed to publish payload, please try again. id:${d} tag:${u}`;try{const l=new Promise(async b=>{const x=({id:D})=>{g.opts.id===D&&(this.removeRequestFromQueue(D),this.relayer.events.removeListener(core_dist_index_es_C.publish,x),b(g))};this.relayer.events.on(core_dist_index_es_C.publish,x);const I=index_es_uo(new Promise((D,j)=>{this.rpcPublish({topic:s,message:i,ttl:a,prompt:h,tag:u,id:d,attestation:n?.attestation,tvf:n?.tvf}).then(D).catch(T=>{this.logger.warn(T,T?.message),j(T)})}),this.initialPublishTimeout,`Failed initial publish, retrying.... id:${d} tag:${u}`);try{await I,this.events.removeListener(core_dist_index_es_C.publish,x)}catch(D){this.queue.set(d,dist_index_es_Ge(dist_index_es_Ie({},g),{attempt:1})),this.logger.warn(D,D?.message)}});this.logger.trace({type:"method",method:"publish",params:{id:d,topic:s,message:i,opts:n}}),await index_es_uo(l,this.publishTimeout,_)}catch(l){if(this.logger.debug("Failed to Publish Payload"),this.logger.error(l),(o=n?.internal)!=null&&o.throwOnFailedPublish)throw l}finally{this.queue.delete(d)}}),dist_index_es_V(this,"on",(s,i)=>{this.events.on(s,i)}),dist_index_es_V(this,"once",(s,i)=>{this.events.once(s,i)}),dist_index_es_V(this,"off",(s,i)=>{this.events.off(s,i)}),dist_index_es_V(this,"removeListener",(s,i)=>{this.events.removeListener(s,i)}),this.relayer=e,this.logger=dist_index_es_E(t,this.name),this.registerEventListeners()}get context(){return index_es_y(this.logger)}async rpcPublish(e){var t,s,i,n;const{topic:o,message:a,ttl:c=dist_index_es_je,prompt:h,tag:u,id:d,attestation:g,tvf:_}=e,l={method:wi(bi().protocol).publish,params:dist_index_es_Ie({topic:o,message:a,ttl:c,prompt:h,tag:u,attestation:g},_),id:d};ae((t=l.params)==null?void 0:t.prompt)&&((s=l.params)==null||delete s.prompt),ae((i=l.params)==null?void 0:i.tag)&&((n=l.params)==null||delete n.tag),this.logger.debug("Outgoing Relay Payload"),this.logger.trace({type:"message",direction:"outgoing",request:l});const b=await this.relayer.request(l);return this.relayer.events.emit(core_dist_index_es_C.publish,e),this.logger.debug("Successfully Published Payload"),b}removeRequestFromQueue(e){this.queue.delete(e)}checkQueue(){this.queue.forEach(async(e,t)=>{const s=e.attempt+1;this.queue.set(t,dist_index_es_Ge(dist_index_es_Ie({},e),{attempt:s}));const{topic:i,message:n,opts:o,attestation:a}=e;this.logger.warn({},`Publisher: queue->publishing: ${e.opts.id}, tag: ${e.opts.tag}, attempt: ${s}`),await this.rpcPublish(dist_index_es_Ge(dist_index_es_Ie({},e),{topic:i,message:n,ttl:o.ttl,prompt:o.prompt,tag:o.tag,id:o.id,attestation:a,tvf:o.tvf})),this.logger.warn({},`Publisher: queue->published: ${e.opts.id}`)})}registerEventListeners(){this.relayer.core.heartbeat.on(r.pulse,()=>{if(this.needsTransportRestart){this.needsTransportRestart=!1,this.relayer.events.emit(core_dist_index_es_C.connection_stalled);return}this.checkQueue()}),this.relayer.on(core_dist_index_es_C.message_ack,e=>{this.removeRequestFromQueue(e.id.toString())})}}var dist_index_es_qn=Object.defineProperty,dist_index_es_Gn=(r,e,t)=>e in r?dist_index_es_qn(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_re=(r,e,t)=>dist_index_es_Gn(r,typeof e!="symbol"?e+"":e,t);class dist_index_es_Wn{constructor(){index_es_re(this,"map",new Map),index_es_re(this,"set",(e,t)=>{const s=this.get(e);this.exists(e,t)||this.map.set(e,[...s,t])}),index_es_re(this,"get",e=>this.map.get(e)||[]),index_es_re(this,"exists",(e,t)=>this.get(e).includes(t)),index_es_re(this,"delete",(e,t)=>{if(typeof t>"u"){this.map.delete(e);return}if(!this.map.has(e))return;const s=this.get(e);if(!this.exists(e,t))return;const i=s.filter(n=>n!==t);if(!i.length){this.map.delete(e);return}this.map.set(e,i)}),index_es_re(this,"clear",()=>{this.map.clear()})}get topics(){return Array.from(this.map.keys())}}var dist_index_es_Hn=Object.defineProperty,dist_index_es_Yn=Object.defineProperties,dist_index_es_Jn=Object.getOwnPropertyDescriptors,index_es_Ii=Object.getOwnPropertySymbols,dist_index_es_Xn=Object.prototype.hasOwnProperty,dist_index_es_Zn=Object.prototype.propertyIsEnumerable,index_es_We=(r,e,t)=>e in r?dist_index_es_Hn(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_ge=(r,e)=>{for(var t in e||(e={}))dist_index_es_Xn.call(e,t)&&index_es_We(r,t,e[t]);if(index_es_Ii)for(var t of index_es_Ii(e))dist_index_es_Zn.call(e,t)&&index_es_We(r,t,e[t]);return r},dist_index_es_He=(r,e)=>dist_index_es_Yn(r,dist_index_es_Jn(e)),core_dist_index_es_f=(r,e,t)=>index_es_We(r,typeof e!="symbol"?e+"":e,t);class index_es_Ti extends dist_index_es_P{constructor(e,t){super(e,t),this.relayer=e,this.logger=t,core_dist_index_es_f(this,"subscriptions",new Map),core_dist_index_es_f(this,"topicMap",new dist_index_es_Wn),core_dist_index_es_f(this,"events",new external_events_.EventEmitter),core_dist_index_es_f(this,"name",dist_index_es_Ut),core_dist_index_es_f(this,"version",dist_index_es_Mt),core_dist_index_es_f(this,"pending",new Map),core_dist_index_es_f(this,"cached",[]),core_dist_index_es_f(this,"initialized",!1),core_dist_index_es_f(this,"storagePrefix",index_es_B),core_dist_index_es_f(this,"subscribeTimeout",(0,cjs.toMiliseconds)(cjs.ONE_MINUTE)),core_dist_index_es_f(this,"initialSubscribeTimeout",(0,cjs.toMiliseconds)(cjs.ONE_SECOND*15)),core_dist_index_es_f(this,"clientId"),core_dist_index_es_f(this,"batchSubscribeTopicsLimit",500),core_dist_index_es_f(this,"init",async()=>{this.initialized||(this.logger.trace("Initialized"),this.registerEventListeners(),await this.restore()),this.initialized=!0}),core_dist_index_es_f(this,"subscribe",async(s,i)=>{this.isInitialized(),this.logger.debug("Subscribing Topic"),this.logger.trace({type:"method",method:"subscribe",params:{topic:s,opts:i}});try{const n=bi(i),o={topic:s,relay:n,transportType:i?.transportType};this.pending.set(s,o);const a=await this.rpcSubscribe(s,n,i);return typeof a=="string"&&(this.onSubscribe(a,o),this.logger.debug("Successfully Subscribed Topic"),this.logger.trace({type:"method",method:"subscribe",params:{topic:s,opts:i}})),a}catch(n){throw this.logger.debug("Failed to Subscribe Topic"),this.logger.error(n),n}}),core_dist_index_es_f(this,"unsubscribe",async(s,i)=>{this.isInitialized(),typeof i?.id<"u"?await this.unsubscribeById(s,i.id,i):await this.unsubscribeByTopic(s,i)}),core_dist_index_es_f(this,"isSubscribed",s=>new Promise(i=>{i(this.topicMap.topics.includes(s))})),core_dist_index_es_f(this,"isKnownTopic",s=>new Promise(i=>{i(this.topicMap.topics.includes(s)||this.pending.has(s)||this.cached.some(n=>n.topic===s))})),core_dist_index_es_f(this,"on",(s,i)=>{this.events.on(s,i)}),core_dist_index_es_f(this,"once",(s,i)=>{this.events.once(s,i)}),core_dist_index_es_f(this,"off",(s,i)=>{this.events.off(s,i)}),core_dist_index_es_f(this,"removeListener",(s,i)=>{this.events.removeListener(s,i)}),core_dist_index_es_f(this,"start",async()=>{await this.onConnect()}),core_dist_index_es_f(this,"stop",async()=>{await this.onDisconnect()}),core_dist_index_es_f(this,"restart",async()=>{await this.restore(),await this.onRestart()}),core_dist_index_es_f(this,"checkPending",async()=>{if(this.pending.size===0&&(!this.initialized||!this.relayer.connected))return;const s=[];this.pending.forEach(i=>{s.push(i)}),await this.batchSubscribe(s)}),core_dist_index_es_f(this,"registerEventListeners",()=>{this.relayer.core.heartbeat.on(r.pulse,async()=>{await this.checkPending()}),this.events.on(index_es_$.created,async s=>{const i=index_es_$.created;this.logger.info(`Emitting ${i}`),this.logger.debug({type:"event",event:i,data:s}),await this.persist()}),this.events.on(index_es_$.deleted,async s=>{const i=index_es_$.deleted;this.logger.info(`Emitting ${i}`),this.logger.debug({type:"event",event:i,data:s}),await this.persist()})}),this.relayer=e,this.logger=dist_index_es_E(t,this.name),this.clientId=""}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.relayer.core.customStoragePrefix+"//"+this.name}get length(){return this.subscriptions.size}get ids(){return Array.from(this.subscriptions.keys())}get values(){return Array.from(this.subscriptions.values())}get topics(){return this.topicMap.topics}get hasAnyTopics(){return this.topicMap.topics.length>0||this.pending.size>0||this.cached.length>0||this.subscriptions.size>0}hasSubscription(e,t){let s=!1;try{s=this.getSubscription(e).topic===t}catch{}return s}reset(){this.cached=[],this.initialized=!0}onDisable(){this.cached=this.values,this.subscriptions.clear(),this.topicMap.clear()}async unsubscribeByTopic(e,t){const s=this.topicMap.get(e);await Promise.all(s.map(async i=>await this.unsubscribeById(e,i,t)))}async unsubscribeById(e,t,s){this.logger.debug("Unsubscribing Topic"),this.logger.trace({type:"method",method:"unsubscribe",params:{topic:e,id:t,opts:s}});try{const i=bi(s);await this.restartToComplete({topic:e,id:t,relay:i}),await this.rpcUnsubscribe(e,t,i);const n=index_es_de("USER_DISCONNECTED",`${this.name}, ${e}`);await this.onUnsubscribe(e,t,n),this.logger.debug("Successfully Unsubscribed Topic"),this.logger.trace({type:"method",method:"unsubscribe",params:{topic:e,id:t,opts:s}})}catch(i){throw this.logger.debug("Failed to Unsubscribe Topic"),this.logger.error(i),i}}async rpcSubscribe(e,t,s){var i;(!s||s?.transportType===dist_index_es_Q.relay)&&await this.restartToComplete({topic:e,id:e,relay:t});const n={method:wi(t.protocol).subscribe,params:{topic:e}};this.logger.debug("Outgoing Relay Payload"),this.logger.trace({type:"payload",direction:"outgoing",request:n});const o=(i=s?.internal)==null?void 0:i.throwOnFailedPublish;try{const a=await this.getSubscriptionId(e);if(s?.transportType===dist_index_es_Q.link_mode)return setTimeout(()=>{(this.relayer.connected||this.relayer.connecting)&&this.relayer.request(n).catch(u=>this.logger.warn(u))},(0,cjs.toMiliseconds)(cjs.ONE_SECOND)),a;const c=new Promise(async u=>{const d=g=>{g.topic===e&&(this.events.removeListener(index_es_$.created,d),u(g.id))};this.events.on(index_es_$.created,d);try{const g=await index_es_uo(new Promise((_,l)=>{this.relayer.request(n).catch(b=>{this.logger.warn(b,b?.message),l(b)}).then(_)}),this.initialSubscribeTimeout,`Subscribing to ${e} failed, please try again`);this.events.removeListener(index_es_$.created,d),u(g)}catch{}}),h=await index_es_uo(c,this.subscribeTimeout,`Subscribing to ${e} failed, please try again`);if(!h&&o)throw new Error(`Subscribing to ${e} failed, please try again`);return h?a:null}catch(a){if(this.logger.debug("Outgoing Relay Subscribe Payload stalled"),this.relayer.events.emit(core_dist_index_es_C.connection_stalled),o)throw a}return null}async rpcBatchSubscribe(e){if(!e.length)return;const t=e[0].relay,s={method:wi(t.protocol).batchSubscribe,params:{topics:e.map(i=>i.topic)}};this.logger.debug("Outgoing Relay Payload"),this.logger.trace({type:"payload",direction:"outgoing",request:s});try{await await index_es_uo(new Promise(i=>{this.relayer.request(s).catch(n=>this.logger.warn(n)).then(i)}),this.subscribeTimeout,"rpcBatchSubscribe failed, please try again")}catch{this.relayer.events.emit(core_dist_index_es_C.connection_stalled)}}async rpcBatchFetchMessages(e){if(!e.length)return;const t=e[0].relay,s={method:wi(t.protocol).batchFetchMessages,params:{topics:e.map(n=>n.topic)}};this.logger.debug("Outgoing Relay Payload"),this.logger.trace({type:"payload",direction:"outgoing",request:s});let i;try{i=await await index_es_uo(new Promise((n,o)=>{this.relayer.request(s).catch(a=>{this.logger.warn(a),o(a)}).then(n)}),this.subscribeTimeout,"rpcBatchFetchMessages failed, please try again")}catch{this.relayer.events.emit(core_dist_index_es_C.connection_stalled)}return i}rpcUnsubscribe(e,t,s){const i={method:wi(s.protocol).unsubscribe,params:{topic:e,id:t}};return this.logger.debug("Outgoing Relay Payload"),this.logger.trace({type:"payload",direction:"outgoing",request:i}),this.relayer.request(i)}onSubscribe(e,t){this.setSubscription(e,dist_index_es_He(index_es_ge({},t),{id:e})),this.pending.delete(t.topic)}onBatchSubscribe(e){e.length&&e.forEach(t=>{this.setSubscription(t.id,index_es_ge({},t)),this.pending.delete(t.topic)})}async onUnsubscribe(e,t,s){this.events.removeAllListeners(t),this.hasSubscription(t,e)&&this.deleteSubscription(t,s),await this.relayer.messages.del(e)}async setRelayerSubscriptions(e){await this.relayer.core.storage.setItem(this.storageKey,e)}async getRelayerSubscriptions(){return await this.relayer.core.storage.getItem(this.storageKey)}setSubscription(e,t){this.logger.debug("Setting subscription"),this.logger.trace({type:"method",method:"setSubscription",id:e,subscription:t}),this.addSubscription(e,t)}addSubscription(e,t){this.subscriptions.set(e,index_es_ge({},t)),this.topicMap.set(t.topic,e),this.events.emit(index_es_$.created,t)}getSubscription(e){this.logger.debug("Getting subscription"),this.logger.trace({type:"method",method:"getSubscription",id:e});const t=this.subscriptions.get(e);if(!t){const{message:s}=dist_index_es_te("NO_MATCHING_KEY",`${this.name}: ${e}`);throw new Error(s)}return t}deleteSubscription(e,t){this.logger.debug("Deleting subscription"),this.logger.trace({type:"method",method:"deleteSubscription",id:e,reason:t});const s=this.getSubscription(e);this.subscriptions.delete(e),this.topicMap.delete(s.topic,e),this.events.emit(index_es_$.deleted,dist_index_es_He(index_es_ge({},s),{reason:t}))}async persist(){await this.setRelayerSubscriptions(this.values),this.events.emit(index_es_$.sync)}async onRestart(){if(this.cached.length){const e=[...this.cached],t=Math.ceil(this.cached.length/this.batchSubscribeTopicsLimit);for(let s=0;s<t;s++){const i=e.splice(0,this.batchSubscribeTopicsLimit);await this.batchSubscribe(i)}}this.events.emit(index_es_$.resubscribed)}async restore(){try{const e=await this.getRelayerSubscriptions();if(typeof e>"u"||!e.length)return;if(this.subscriptions.size){const{message:t}=dist_index_es_te("RESTORE_WILL_OVERRIDE",this.name);throw this.logger.error(t),this.logger.error(`${this.name}: ${JSON.stringify(this.values)}`),new Error(t)}this.cached=e,this.logger.debug(`Successfully Restored subscriptions for ${this.name}`),this.logger.trace({type:"method",method:"restore",subscriptions:this.values})}catch(e){this.logger.debug(`Failed to Restore subscriptions for ${this.name}`),this.logger.error(e)}}async batchSubscribe(e){e.length&&(await this.rpcBatchSubscribe(e),this.onBatchSubscribe(await Promise.all(e.map(async t=>dist_index_es_He(index_es_ge({},t),{id:await this.getSubscriptionId(t.topic)})))))}async batchFetchMessages(e){if(!e.length)return;this.logger.trace(`Fetching batch messages for ${e.length} subscriptions`);const t=await this.rpcBatchFetchMessages(e);t&&t.messages&&(await index_es_xo((0,cjs.toMiliseconds)(cjs.ONE_SECOND)),await this.relayer.handleBatchMessageEvents(t.messages))}async onConnect(){await this.restart(),this.reset()}onDisconnect(){this.onDisable()}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}async restartToComplete(e){!this.relayer.connected&&!this.relayer.connecting&&(this.cached.push(e),await this.relayer.transportOpen())}async getClientId(){return this.clientId||(this.clientId=await this.relayer.core.crypto.getClientId()),this.clientId}async getSubscriptionId(e){return ci(e+await this.getClientId())}}var dist_index_es_Qn=Object.defineProperty,index_es_Ci=Object.getOwnPropertySymbols,dist_index_es_eo=Object.prototype.hasOwnProperty,dist_index_es_to=Object.prototype.propertyIsEnumerable,dist_index_es_Ye=(r,e,t)=>e in r?dist_index_es_Qn(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_Pi=(r,e)=>{for(var t in e||(e={}))dist_index_es_eo.call(e,t)&&dist_index_es_Ye(r,t,e[t]);if(index_es_Ci)for(var t of index_es_Ci(e))dist_index_es_to.call(e,t)&&dist_index_es_Ye(r,t,e[t]);return r},core_dist_index_es_y=(r,e,t)=>dist_index_es_Ye(r,typeof e!="symbol"?e+"":e,t);class index_es_Si extends dist_index_es_d{constructor(e){super(e),core_dist_index_es_y(this,"protocol","wc"),core_dist_index_es_y(this,"version",2),core_dist_index_es_y(this,"core"),core_dist_index_es_y(this,"logger"),core_dist_index_es_y(this,"events",new external_events_.EventEmitter),core_dist_index_es_y(this,"provider"),core_dist_index_es_y(this,"messages"),core_dist_index_es_y(this,"subscriber"),core_dist_index_es_y(this,"publisher"),core_dist_index_es_y(this,"name",dist_index_es_$t),core_dist_index_es_y(this,"transportExplicitlyClosed",!1),core_dist_index_es_y(this,"initialized",!1),core_dist_index_es_y(this,"connectionAttemptInProgress",!1),core_dist_index_es_y(this,"relayUrl"),core_dist_index_es_y(this,"projectId"),core_dist_index_es_y(this,"packageName"),core_dist_index_es_y(this,"bundleId"),core_dist_index_es_y(this,"hasExperiencedNetworkDisruption",!1),core_dist_index_es_y(this,"pingTimeout"),core_dist_index_es_y(this,"heartBeatTimeout",(0,cjs.toMiliseconds)(cjs.THIRTY_SECONDS+cjs.FIVE_SECONDS)),core_dist_index_es_y(this,"reconnectTimeout"),core_dist_index_es_y(this,"connectPromise"),core_dist_index_es_y(this,"reconnectInProgress",!1),core_dist_index_es_y(this,"requestsInFlight",[]),core_dist_index_es_y(this,"connectTimeout",(0,cjs.toMiliseconds)(cjs.ONE_SECOND*15)),core_dist_index_es_y(this,"request",async t=>{var s,i;this.logger.debug("Publishing Request Payload");const n=t.id||getBigIntRpcId().toString();await this.toEstablishConnection();try{this.logger.trace({id:n,method:t.method,topic:(s=t.params)==null?void 0:s.topic},"relayer.request - publishing...");const o=`${n}:${((i=t.params)==null?void 0:i.tag)||""}`;this.requestsInFlight.push(o);const a=await this.provider.request(t);return this.requestsInFlight=this.requestsInFlight.filter(c=>c!==o),a}catch(o){throw this.logger.debug(`Failed to Publish Request: ${n}`),o}}),core_dist_index_es_y(this,"resetPingTimeout",()=>{et()&&(clearTimeout(this.pingTimeout),this.pingTimeout=setTimeout(()=>{var t,s,i,n;try{this.logger.debug({},"pingTimeout: Connection stalled, terminating..."),(n=(i=(s=(t=this.provider)==null?void 0:t.connection)==null?void 0:s.socket)==null?void 0:i.terminate)==null||n.call(i)}catch(o){this.logger.warn(o,o?.message)}},this.heartBeatTimeout))}),core_dist_index_es_y(this,"onPayloadHandler",t=>{this.onProviderPayload(t),this.resetPingTimeout()}),core_dist_index_es_y(this,"onConnectHandler",()=>{this.logger.warn({},"Relayer connected \u{1F6DC}"),this.startPingTimeout(),this.events.emit(core_dist_index_es_C.connect)}),core_dist_index_es_y(this,"onDisconnectHandler",()=>{this.logger.warn({},"Relayer disconnected \u{1F6D1}"),this.requestsInFlight=[],this.onProviderDisconnect()}),core_dist_index_es_y(this,"onProviderErrorHandler",t=>{this.logger.fatal(`Fatal socket error: ${t.message}`),this.events.emit(core_dist_index_es_C.error,t),this.logger.fatal("Fatal socket error received, closing transport"),this.transportClose()}),core_dist_index_es_y(this,"registerProviderListeners",()=>{this.provider.on(index_es_L.payload,this.onPayloadHandler),this.provider.on(index_es_L.connect,this.onConnectHandler),this.provider.on(index_es_L.disconnect,this.onDisconnectHandler),this.provider.on(index_es_L.error,this.onProviderErrorHandler)}),this.core=e.core,this.logger=typeof e.logger<"u"&&typeof e.logger!="string"?dist_index_es_E(e.logger,this.name):pino_default()(logger_dist_index_es_k({level:e.logger||dist_index_es_Nt})),this.messages=new core_dist_index_es_i(this.logger,e.core),this.subscriber=new index_es_Ti(this,this.logger),this.publisher=new dist_index_es_Vn(this,this.logger),this.relayUrl=e?.relayUrl||dist_index_es_Ue,this.projectId=e.projectId,index_es_zr()?this.packageName=index_es_Yr():index_es_Jr()&&(this.bundleId=index_es_Yr()),this.provider={}}async init(){if(this.logger.trace("Initialized"),this.registerEventListeners(),await Promise.all([this.messages.init(),this.subscriber.init()]),this.initialized=!0,this.subscriber.hasAnyTopics)try{await this.transportOpen()}catch(e){this.logger.warn(e,e?.message)}}get context(){return index_es_y(this.logger)}get connected(){var e,t,s;return((s=(t=(e=this.provider)==null?void 0:e.connection)==null?void 0:t.socket)==null?void 0:s.readyState)===1||!1}get connecting(){var e,t,s;return((s=(t=(e=this.provider)==null?void 0:e.connection)==null?void 0:t.socket)==null?void 0:s.readyState)===0||this.connectPromise!==void 0||!1}async publish(e,t,s){this.isInitialized(),await this.publisher.publish(e,t,s),await this.recordMessageEvent({topic:e,message:t,publishedAt:Date.now(),transportType:dist_index_es_Q.relay},dist_index_es_le.outbound)}async subscribe(e,t){var s,i,n;this.isInitialized(),(!(t!=null&&t.transportType)||t?.transportType==="relay")&&await this.toEstablishConnection();const o=typeof((s=t?.internal)==null?void 0:s.throwOnFailedPublish)>"u"?!0:(i=t?.internal)==null?void 0:i.throwOnFailedPublish;let a=((n=this.subscriber.topicMap.get(e))==null?void 0:n[0])||"",c;const h=u=>{u.topic===e&&(this.subscriber.off(index_es_$.created,h),c())};return await Promise.all([new Promise(u=>{c=u,this.subscriber.on(index_es_$.created,h)}),new Promise(async(u,d)=>{a=await this.subscriber.subscribe(e,index_es_Pi({internal:{throwOnFailedPublish:o}},t)).catch(g=>{o&&d(g)})||a,u()})]),a}async unsubscribe(e,t){this.isInitialized(),await this.subscriber.unsubscribe(e,t)}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeListener(e,t){this.events.removeListener(e,t)}async transportDisconnect(){this.provider.disconnect&&(this.hasExperiencedNetworkDisruption||this.connected)?await index_es_uo(this.provider.disconnect(),2e3,"provider.disconnect()").catch(()=>this.onProviderDisconnect()):this.onProviderDisconnect()}async transportClose(){this.transportExplicitlyClosed=!0,await this.transportDisconnect()}async transportOpen(e){if(!this.subscriber.hasAnyTopics){this.logger.warn("Starting WS connection skipped because the client has no topics to work with.");return}if(this.connectPromise?(this.logger.debug({},"Waiting for existing connection attempt to resolve..."),await this.connectPromise,this.logger.debug({},"Existing connection attempt resolved")):(this.connectPromise=new Promise(async(t,s)=>{await this.connect(e).then(t).catch(s).finally(()=>{this.connectPromise=void 0})}),await this.connectPromise),!this.connected)throw new Error(`Couldn't establish socket connection to the relay server: ${this.relayUrl}`)}async restartTransport(e){this.logger.debug({},"Restarting transport..."),!this.connectionAttemptInProgress&&(this.relayUrl=e||this.relayUrl,await this.confirmOnlineStateOrThrow(),await this.transportClose(),await this.transportOpen())}async confirmOnlineStateOrThrow(){if(!await Zi())throw new Error("No internet connection detected. Please restart your network and try again.")}async handleBatchMessageEvents(e){if(e?.length===0){this.logger.trace("Batch message events is empty. Ignoring...");return}const t=e.sort((s,i)=>s.publishedAt-i.publishedAt);this.logger.debug(`Batch of ${t.length} message events sorted`);for(const s of t)try{await this.onMessageEvent(s)}catch(i){this.logger.warn(i,"Error while processing batch message event: "+i?.message)}this.logger.trace(`Batch of ${t.length} message events processed`)}async onLinkMessageEvent(e,t){const{topic:s}=e;if(!t.sessionExists){const i=index_es_po(cjs.FIVE_MINUTES),n={topic:s,expiry:i,relay:{protocol:"irn"},active:!1};await this.core.pairing.pairings.set(s,n)}this.events.emit(core_dist_index_es_C.message,e),await this.recordMessageEvent(e,dist_index_es_le.inbound)}async connect(e){await this.confirmOnlineStateOrThrow(),e&&e!==this.relayUrl&&(this.relayUrl=e,await this.transportDisconnect()),this.connectionAttemptInProgress=!0,this.transportExplicitlyClosed=!1;let t=1;for(;t<6;){try{if(this.transportExplicitlyClosed)break;this.logger.debug({},`Connecting to ${this.relayUrl}, attempt: ${t}...`),await this.createProvider(),await new Promise(async(s,i)=>{const n=()=>{i(new Error("Connection interrupted while trying to subscribe"))};this.provider.once(index_es_L.disconnect,n),await index_es_uo(new Promise((o,a)=>{this.provider.connect().then(o).catch(a)}),this.connectTimeout,`Socket stalled when trying to connect to ${this.relayUrl}`).catch(o=>{i(o)}).finally(()=>{this.provider.off(index_es_L.disconnect,n),clearTimeout(this.reconnectTimeout)}),await new Promise(async(o,a)=>{const c=()=>{a(new Error("Connection interrupted while trying to subscribe"))};this.provider.once(index_es_L.disconnect,c),await this.subscriber.start().then(o).catch(a).finally(()=>{this.provider.off(index_es_L.disconnect,c)})}),this.hasExperiencedNetworkDisruption=!1,s()})}catch(s){await this.subscriber.stop();const i=s;this.logger.warn({},i.message),this.hasExperiencedNetworkDisruption=!0}finally{this.connectionAttemptInProgress=!1}if(this.connected){this.logger.debug({},`Connected to ${this.relayUrl} successfully on attempt: ${t}`);break}await new Promise(s=>setTimeout(s,(0,cjs.toMiliseconds)(t*1))),t++}}startPingTimeout(){var e,t,s,i,n;if(et())try{(t=(e=this.provider)==null?void 0:e.connection)!=null&&t.socket&&((n=(i=(s=this.provider)==null?void 0:s.connection)==null?void 0:i.socket)==null||n.on("ping",()=>{this.resetPingTimeout()})),this.resetPingTimeout()}catch(o){this.logger.warn(o,o?.message)}}async createProvider(){this.provider.connection&&this.unregisterProviderListeners();const e=await this.core.crypto.signJWT(this.relayUrl);this.provider=new jsonrpc_provider_dist_index_es_o(new jsonrpc_ws_connection_dist_index_es_f(index_es_Qr({sdkVersion:core_dist_index_es_e,protocol:this.protocol,version:this.version,relayUrl:this.relayUrl,projectId:this.projectId,auth:e,useOnCloseEvent:!0,bundleId:this.bundleId,packageName:this.packageName}))),this.registerProviderListeners()}async recordMessageEvent(e,t){const{topic:s,message:i}=e;await this.messages.set(s,i,t)}async shouldIgnoreMessageEvent(e){const{topic:t,message:s}=e;if(!s||s.length===0)return this.logger.warn(`Ignoring invalid/empty message: ${s}`),!0;if(!await this.subscriber.isKnownTopic(t))return this.logger.warn(`Ignoring message for unknown topic ${t}`),!0;const i=this.messages.has(t,s);return i&&this.logger.warn(`Ignoring duplicate message: ${s}`),i}async onProviderPayload(e){if(this.logger.debug("Incoming Relay Payload"),this.logger.trace({type:"payload",direction:"incoming",payload:e}),isJsonRpcRequest(e)){if(!e.method.endsWith(dist_index_es_zt))return;const t=e.params,{topic:s,message:i,publishedAt:n,attestation:o}=t.data,a={topic:s,message:i,publishedAt:n,transportType:dist_index_es_Q.relay,attestation:o};this.logger.debug("Emitting Relayer Payload"),this.logger.trace(index_es_Pi({type:"event",event:t.id},a)),this.events.emit(t.id,a),await this.acknowledgePayload(e),await this.onMessageEvent(a)}else isJsonRpcResponse(e)&&this.events.emit(core_dist_index_es_C.message_ack,e)}async onMessageEvent(e){await this.shouldIgnoreMessageEvent(e)||(await this.recordMessageEvent(e,dist_index_es_le.inbound),this.events.emit(core_dist_index_es_C.message,e))}async acknowledgePayload(e){const t=formatJsonRpcResult(e.id,!0);await this.provider.connection.send(t)}unregisterProviderListeners(){this.provider.off(index_es_L.payload,this.onPayloadHandler),this.provider.off(index_es_L.connect,this.onConnectHandler),this.provider.off(index_es_L.disconnect,this.onDisconnectHandler),this.provider.off(index_es_L.error,this.onProviderErrorHandler),clearTimeout(this.pingTimeout)}async registerEventListeners(){let e=await Zi();Qi(async t=>{e!==t&&(e=t,t?await this.transportOpen().catch(s=>this.logger.error(s,s?.message)):(this.hasExperiencedNetworkDisruption=!0,await this.transportDisconnect(),this.transportExplicitlyClosed=!1))})}async onProviderDisconnect(){clearTimeout(this.pingTimeout),this.events.emit(core_dist_index_es_C.disconnect),this.connectionAttemptInProgress=!1,!this.reconnectInProgress&&(this.reconnectInProgress=!0,await this.subscriber.stop(),this.subscriber.hasAnyTopics&&(this.transportExplicitlyClosed||(this.reconnectTimeout=setTimeout(async()=>{await this.transportOpen().catch(e=>this.logger.error(e,e?.message)),this.reconnectTimeout=void 0,this.reconnectInProgress=!1},(0,cjs.toMiliseconds)(dist_index_es_Lt)))))}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}async toEstablishConnection(){await this.confirmOnlineStateOrThrow(),!this.connected&&await this.connect()}}function dist_index_es_io(){}function index_es_Ri(r){if(!r||typeof r!="object")return!1;const e=Object.getPrototypeOf(r);return e===null||e===Object.prototype||Object.getPrototypeOf(e)===null?Object.prototype.toString.call(r)==="[object Object]":!1}function index_es_Oi(r){return Object.getOwnPropertySymbols(r).filter(e=>Object.prototype.propertyIsEnumerable.call(r,e))}function index_es_Ai(r){return r==null?r===void 0?"[object Undefined]":"[object Null]":Object.prototype.toString.call(r)}const dist_index_es_so="[object RegExp]",dist_index_es_ro="[object String]",dist_index_es_no="[object Number]",dist_index_es_oo="[object Boolean]",index_es_xi="[object Arguments]",dist_index_es_ao="[object Symbol]",dist_index_es_co="[object Date]",dist_index_es_ho="[object Map]",dist_index_es_lo="[object Set]",dist_index_es_uo="[object Array]",dist_index_es_go="[object Function]",dist_index_es_po="[object ArrayBuffer]",index_es_Je="[object Object]",dist_index_es_yo="[object Error]",dist_index_es_bo="[object DataView]",dist_index_es_mo="[object Uint8Array]",dist_index_es_fo="[object Uint8ClampedArray]",dist_index_es_Do="[object Uint16Array]",dist_index_es_vo="[object Uint32Array]",dist_index_es_wo="[object BigUint64Array]",core_dist_index_es_o="[object Int8Array]",dist_index_es_Eo="[object Int16Array]",dist_index_es_Io="[object Int32Array]",dist_index_es_To="[object BigInt64Array]",dist_index_es_Co="[object Float32Array]",dist_index_es_Po="[object Float64Array]";function dist_index_es_So(r,e){return r===e||Number.isNaN(r)&&Number.isNaN(e)}function dist_index_es_Ro(r,e,t){return index_es_pe(r,e,void 0,void 0,void 0,void 0,t)}function index_es_pe(r,e,t,s,i,n,o){const a=o(r,e,t,s,i,n);if(a!==void 0)return a;if(typeof r==typeof e)switch(typeof r){case"bigint":case"string":case"boolean":case"symbol":case"undefined":return r===e;case"number":return r===e||Object.is(r,e);case"function":return r===e;case"object":return index_es_ye(r,e,n,o)}return index_es_ye(r,e,n,o)}function index_es_ye(r,e,t,s){if(Object.is(r,e))return!0;let i=index_es_Ai(r),n=index_es_Ai(e);if(i===index_es_xi&&(i=index_es_Je),n===index_es_xi&&(n=index_es_Je),i!==n)return!1;switch(i){case dist_index_es_ro:return r.toString()===e.toString();case dist_index_es_no:{const c=r.valueOf(),h=e.valueOf();return dist_index_es_So(c,h)}case dist_index_es_oo:case dist_index_es_co:case dist_index_es_ao:return Object.is(r.valueOf(),e.valueOf());case dist_index_es_so:return r.source===e.source&&r.flags===e.flags;case dist_index_es_go:return r===e}t=t??new Map;const o=t.get(r),a=t.get(e);if(o!=null&&a!=null)return o===e;t.set(r,e),t.set(e,r);try{switch(i){case dist_index_es_ho:{if(r.size!==e.size)return!1;for(const[c,h]of r.entries())if(!e.has(c)||!index_es_pe(h,e.get(c),c,r,e,t,s))return!1;return!0}case dist_index_es_lo:{if(r.size!==e.size)return!1;const c=Array.from(r.values()),h=Array.from(e.values());for(let u=0;u<c.length;u++){const d=c[u],g=h.findIndex(_=>index_es_pe(d,_,void 0,r,e,t,s));if(g===-1)return!1;h.splice(g,1)}return!0}case dist_index_es_uo:case dist_index_es_mo:case dist_index_es_fo:case dist_index_es_Do:case dist_index_es_vo:case dist_index_es_wo:case core_dist_index_es_o:case dist_index_es_Eo:case dist_index_es_Io:case dist_index_es_To:case dist_index_es_Co:case dist_index_es_Po:{if(typeof Buffer<"u"&&Buffer.isBuffer(r)!==Buffer.isBuffer(e)||r.length!==e.length)return!1;for(let c=0;c<r.length;c++)if(!index_es_pe(r[c],e[c],c,r,e,t,s))return!1;return!0}case dist_index_es_po:return r.byteLength!==e.byteLength?!1:index_es_ye(new Uint8Array(r),new Uint8Array(e),t,s);case dist_index_es_bo:return r.byteLength!==e.byteLength||r.byteOffset!==e.byteOffset?!1:index_es_ye(new Uint8Array(r),new Uint8Array(e),t,s);case dist_index_es_yo:return r.name===e.name&&r.message===e.message;case index_es_Je:{if(!(index_es_ye(r.constructor,e.constructor,t,s)||index_es_Ri(r)&&index_es_Ri(e)))return!1;const h=[...Object.keys(r),...index_es_Oi(r)],u=[...Object.keys(e),...index_es_Oi(e)];if(h.length!==u.length)return!1;for(let d=0;d<h.length;d++){const g=h[d],_=r[g];if(!Object.hasOwn(e,g))return!1;const l=e[g];if(!index_es_pe(_,l,g,r,e,t,s))return!1}return!0}default:return!1}}finally{t.delete(r),t.delete(e)}}function dist_index_es_Oo(r,e){return dist_index_es_Ro(r,e,dist_index_es_io)}var dist_index_es_Ao=Object.defineProperty,index_es_Ni=Object.getOwnPropertySymbols,dist_index_es_xo=Object.prototype.hasOwnProperty,dist_index_es_No=Object.prototype.propertyIsEnumerable,dist_index_es_Xe=(r,e,t)=>e in r?dist_index_es_Ao(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_$i=(r,e)=>{for(var t in e||(e={}))dist_index_es_xo.call(e,t)&&dist_index_es_Xe(r,t,e[t]);if(index_es_Ni)for(var t of index_es_Ni(e))dist_index_es_No.call(e,t)&&dist_index_es_Xe(r,t,e[t]);return r},core_dist_index_es_z=(r,e,t)=>dist_index_es_Xe(r,typeof e!="symbol"?e+"":e,t);class index_es_zi extends dist_index_es_f{constructor(e,t,s,i=index_es_B,n=void 0){super(e,t,s,i),this.core=e,this.logger=t,this.name=s,core_dist_index_es_z(this,"map",new Map),core_dist_index_es_z(this,"version",dist_index_es_kt),core_dist_index_es_z(this,"cached",[]),core_dist_index_es_z(this,"initialized",!1),core_dist_index_es_z(this,"getKey"),core_dist_index_es_z(this,"storagePrefix",index_es_B),core_dist_index_es_z(this,"recentlyDeleted",[]),core_dist_index_es_z(this,"recentlyDeletedLimit",200),core_dist_index_es_z(this,"init",async()=>{this.initialized||(this.logger.trace("Initialized"),await this.restore(),this.cached.forEach(o=>{this.getKey&&o!==null&&!ae(o)?this.map.set(this.getKey(o),o):Li(o)?this.map.set(o.id,o):ji(o)&&this.map.set(o.topic,o)}),this.cached=[],this.initialized=!0)}),core_dist_index_es_z(this,"set",async(o,a)=>{this.isInitialized(),this.map.has(o)?await this.update(o,a):(this.logger.debug("Setting value"),this.logger.trace({type:"method",method:"set",key:o,value:a}),this.map.set(o,a),await this.persist())}),core_dist_index_es_z(this,"get",o=>(this.isInitialized(),this.logger.debug("Getting value"),this.logger.trace({type:"method",method:"get",key:o}),this.getData(o))),core_dist_index_es_z(this,"getAll",o=>(this.isInitialized(),o?this.values.filter(a=>Object.keys(o).every(c=>dist_index_es_Oo(a[c],o[c]))):this.values)),core_dist_index_es_z(this,"update",async(o,a)=>{this.isInitialized(),this.logger.debug("Updating value"),this.logger.trace({type:"method",method:"update",key:o,update:a});const c=index_es_$i(index_es_$i({},this.getData(o)),a);this.map.set(o,c),await this.persist()}),core_dist_index_es_z(this,"delete",async(o,a)=>{this.isInitialized(),this.map.has(o)&&(this.logger.debug("Deleting value"),this.logger.trace({type:"method",method:"delete",key:o,reason:a}),this.map.delete(o),this.addToRecentlyDeleted(o),await this.persist())}),this.logger=dist_index_es_E(t,this.name),this.storagePrefix=i,this.getKey=n}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name}get length(){return this.map.size}get keys(){return Array.from(this.map.keys())}get values(){return Array.from(this.map.values())}addToRecentlyDeleted(e){this.recentlyDeleted.push(e),this.recentlyDeleted.length>=this.recentlyDeletedLimit&&this.recentlyDeleted.splice(0,this.recentlyDeletedLimit/2)}async setDataStore(e){await this.core.storage.setItem(this.storageKey,e)}async getDataStore(){return await this.core.storage.getItem(this.storageKey)}getData(e){const t=this.map.get(e);if(!t){if(this.recentlyDeleted.includes(e)){const{message:i}=dist_index_es_te("MISSING_OR_INVALID",`Record was recently deleted - ${this.name}: ${e}`);throw this.logger.error(i),new Error(i)}const{message:s}=dist_index_es_te("NO_MATCHING_KEY",`${this.name}: ${e}`);throw this.logger.error(s),new Error(s)}return t}async persist(){await this.setDataStore(this.values)}async restore(){try{const e=await this.getDataStore();if(typeof e>"u"||!e.length)return;if(this.map.size){const{message:t}=dist_index_es_te("RESTORE_WILL_OVERRIDE",this.name);throw this.logger.error(t),new Error(t)}this.cached=e,this.logger.debug(`Successfully Restored value for ${this.name}`),this.logger.trace({type:"method",method:"restore",value:this.values})}catch(e){this.logger.debug(`Failed to Restore value for ${this.name}`),this.logger.error(e)}}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_$o=Object.defineProperty,dist_index_es_zo=(r,e,t)=>e in r?dist_index_es_$o(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,core_dist_index_es_p=(r,e,t)=>dist_index_es_zo(r,typeof e!="symbol"?e+"":e,t);class index_es_Li{constructor(e,t){this.core=e,this.logger=t,core_dist_index_es_p(this,"name",dist_index_es_Ft),core_dist_index_es_p(this,"version",dist_index_es_Kt),core_dist_index_es_p(this,"events",new (external_events_default())),core_dist_index_es_p(this,"pairings"),core_dist_index_es_p(this,"initialized",!1),core_dist_index_es_p(this,"storagePrefix",index_es_B),core_dist_index_es_p(this,"ignoredPayloadTypes",[index_es_Oe]),core_dist_index_es_p(this,"registeredMethods",[]),core_dist_index_es_p(this,"init",async()=>{this.initialized||(await this.pairings.init(),await this.cleanup(),this.registerRelayerEvents(),this.registerExpirerEvents(),this.initialized=!0,this.logger.trace("Initialized"))}),core_dist_index_es_p(this,"register",({methods:s})=>{this.isInitialized(),this.registeredMethods=[...new Set([...this.registeredMethods,...s])]}),core_dist_index_es_p(this,"create",async s=>{this.isInitialized();const i=oi(),n=await this.core.crypto.setSymKey(i),o=index_es_po(cjs.FIVE_MINUTES),a={protocol:dist_index_es_xt},c={topic:n,expiry:o,relay:a,active:!1,methods:s?.methods},h=vi({protocol:this.core.protocol,version:this.core.version,topic:n,symKey:i,relay:a,expiryTimestamp:o,methods:s?.methods});return this.events.emit(index_es_se.create,c),this.core.expirer.set(n,o),await this.pairings.set(n,c),await this.core.relayer.subscribe(n,{transportType:s?.transportType}),{topic:n,uri:h}}),core_dist_index_es_p(this,"pair",async s=>{this.isInitialized();const i=this.core.eventClient.createEvent({properties:{topic:s?.uri,trace:[index_es_G.pairing_started]}});this.isValidPair(s,i);const{topic:n,symKey:o,relay:a,expiryTimestamp:c,methods:h}=Ei(s.uri);i.props.properties.topic=n,i.addTrace(index_es_G.pairing_uri_validation_success),i.addTrace(index_es_G.pairing_uri_not_expired);let u;if(this.pairings.keys.includes(n)){if(u=this.pairings.get(n),i.addTrace(index_es_G.existing_pairing),u.active)throw i.setError(index_es_Y.active_pairing_already_exists),new Error(`Pairing already exists: ${n}. Please try again with a new connection URI.`);i.addTrace(index_es_G.pairing_not_expired)}const d=c||index_es_po(cjs.FIVE_MINUTES),g={topic:n,relay:a,expiry:d,active:!1,methods:h};this.core.expirer.set(n,d),await this.pairings.set(n,g),i.addTrace(index_es_G.store_new_pairing),s.activatePairing&&await this.activate({topic:n}),this.events.emit(index_es_se.create,g),i.addTrace(index_es_G.emit_inactive_pairing),this.core.crypto.keychain.has(n)||await this.core.crypto.setSymKey(o,n),i.addTrace(index_es_G.subscribing_pairing_topic);try{await this.core.relayer.confirmOnlineStateOrThrow()}catch{i.setError(index_es_Y.no_internet_connection)}try{await this.core.relayer.subscribe(n,{relay:a})}catch(_){throw i.setError(index_es_Y.subscribe_pairing_topic_failure),_}return i.addTrace(index_es_G.subscribe_pairing_topic_success),g}),core_dist_index_es_p(this,"activate",async({topic:s})=>{this.isInitialized();const i=index_es_po(cjs.FIVE_MINUTES);this.core.expirer.set(s,i),await this.pairings.update(s,{active:!0,expiry:i})}),core_dist_index_es_p(this,"ping",async s=>{this.isInitialized(),await this.isValidPing(s),this.logger.warn("ping() is deprecated and will be removed in the next major release.");const{topic:i}=s;if(this.pairings.keys.includes(i)){const n=await this.sendRequest(i,"wc_pairingPing",{}),{done:o,resolve:a,reject:c}=index_es_ao();this.events.once(index_es_yo("pairing_ping",n),({error:h})=>{h?c(h):a()}),await o()}}),core_dist_index_es_p(this,"updateExpiry",async({topic:s,expiry:i})=>{this.isInitialized(),await this.pairings.update(s,{expiry:i})}),core_dist_index_es_p(this,"updateMetadata",async({topic:s,metadata:i})=>{this.isInitialized(),await this.pairings.update(s,{peerMetadata:i})}),core_dist_index_es_p(this,"getPairings",()=>(this.isInitialized(),this.pairings.values)),core_dist_index_es_p(this,"disconnect",async s=>{this.isInitialized(),await this.isValidDisconnect(s);const{topic:i}=s;this.pairings.keys.includes(i)&&(await this.sendRequest(i,"wc_pairingDelete",index_es_de("USER_DISCONNECTED")),await this.deletePairing(i))}),core_dist_index_es_p(this,"formatUriFromPairing",s=>{this.isInitialized();const{topic:i,relay:n,expiry:o,methods:a}=s,c=this.core.crypto.keychain.get(i);return vi({protocol:this.core.protocol,version:this.core.version,topic:i,symKey:c,relay:n,expiryTimestamp:o,methods:a})}),core_dist_index_es_p(this,"sendRequest",async(s,i,n)=>{const o=formatJsonRpcRequest(i,n),a=await this.core.crypto.encode(s,o),c=index_es_ie[i].req;return this.core.history.set(s,o),this.core.relayer.publish(s,a,c),o.id}),core_dist_index_es_p(this,"sendResult",async(s,i,n)=>{const o=formatJsonRpcResult(s,n),a=await this.core.crypto.encode(i,o),c=(await this.core.history.get(i,s)).request.method,h=index_es_ie[c].res;await this.core.relayer.publish(i,a,h),await this.core.history.resolve(o)}),core_dist_index_es_p(this,"sendError",async(s,i,n)=>{const o=formatJsonRpcError(s,n),a=await this.core.crypto.encode(i,o),c=(await this.core.history.get(i,s)).request.method,h=index_es_ie[c]?index_es_ie[c].res:index_es_ie.unregistered_method.res;await this.core.relayer.publish(i,a,h),await this.core.history.resolve(o)}),core_dist_index_es_p(this,"deletePairing",async(s,i)=>{await this.core.relayer.unsubscribe(s),await Promise.all([this.pairings.delete(s,index_es_de("USER_DISCONNECTED")),this.core.crypto.deleteSymKey(s),i?Promise.resolve():this.core.expirer.del(s)])}),core_dist_index_es_p(this,"cleanup",async()=>{const s=this.pairings.getAll().filter(i=>index_es_go(i.expiry));await Promise.all(s.map(i=>this.deletePairing(i.topic)))}),core_dist_index_es_p(this,"onRelayEventRequest",async s=>{const{topic:i,payload:n}=s;switch(n.method){case"wc_pairingPing":return await this.onPairingPingRequest(i,n);case"wc_pairingDelete":return await this.onPairingDeleteRequest(i,n);default:return await this.onUnknownRpcMethodRequest(i,n)}}),core_dist_index_es_p(this,"onRelayEventResponse",async s=>{const{topic:i,payload:n}=s,o=(await this.core.history.get(i,n.id)).request.method;switch(o){case"wc_pairingPing":return this.onPairingPingResponse(i,n);default:return this.onUnknownRpcMethodResponse(o)}}),core_dist_index_es_p(this,"onPairingPingRequest",async(s,i)=>{const{id:n}=i;try{this.isValidPing({topic:s}),await this.sendResult(n,s,!0),this.events.emit(index_es_se.ping,{id:n,topic:s})}catch(o){await this.sendError(n,s,o),this.logger.error(o)}}),core_dist_index_es_p(this,"onPairingPingResponse",(s,i)=>{const{id:n}=i;setTimeout(()=>{isJsonRpcResult(i)?this.events.emit(index_es_yo("pairing_ping",n),{}):isJsonRpcError(i)&&this.events.emit(index_es_yo("pairing_ping",n),{error:i.error})},500)}),core_dist_index_es_p(this,"onPairingDeleteRequest",async(s,i)=>{const{id:n}=i;try{this.isValidDisconnect({topic:s}),await this.deletePairing(s),this.events.emit(index_es_se.delete,{id:n,topic:s})}catch(o){await this.sendError(n,s,o),this.logger.error(o)}}),core_dist_index_es_p(this,"onUnknownRpcMethodRequest",async(s,i)=>{const{id:n,method:o}=i;try{if(this.registeredMethods.includes(o))return;const a=index_es_de("WC_METHOD_UNSUPPORTED",o);await this.sendError(n,s,a),this.logger.error(a)}catch(a){await this.sendError(n,s,a),this.logger.error(a)}}),core_dist_index_es_p(this,"onUnknownRpcMethodResponse",s=>{this.registeredMethods.includes(s)||this.logger.error(index_es_de("WC_METHOD_UNSUPPORTED",s))}),core_dist_index_es_p(this,"isValidPair",(s,i)=>{var n;if(!Vi(s)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`pair() params: ${s}`);throw i.setError(index_es_Y.malformed_pairing_uri),new Error(a)}if(!Bi(s.uri)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`pair() uri: ${s.uri}`);throw i.setError(index_es_Y.malformed_pairing_uri),new Error(a)}const o=Ei(s?.uri);if(!((n=o?.relay)!=null&&n.protocol)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID","pair() uri#relay-protocol");throw i.setError(index_es_Y.malformed_pairing_uri),new Error(a)}if(!(o!=null&&o.symKey)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID","pair() uri#symKey");throw i.setError(index_es_Y.malformed_pairing_uri),new Error(a)}if(o!=null&&o.expiryTimestamp&&(0,cjs.toMiliseconds)(o?.expiryTimestamp)<Date.now()){i.setError(index_es_Y.pairing_expired);const{message:a}=dist_index_es_te("EXPIRED","pair() URI has expired. Please try again with a new connection URI.");throw new Error(a)}}),core_dist_index_es_p(this,"isValidPing",async s=>{if(!Vi(s)){const{message:n}=dist_index_es_te("MISSING_OR_INVALID",`ping() params: ${s}`);throw new Error(n)}const{topic:i}=s;await this.isValidPairingTopic(i)}),core_dist_index_es_p(this,"isValidDisconnect",async s=>{if(!Vi(s)){const{message:n}=dist_index_es_te("MISSING_OR_INVALID",`disconnect() params: ${s}`);throw new Error(n)}const{topic:i}=s;await this.isValidPairingTopic(i)}),core_dist_index_es_p(this,"isValidPairingTopic",async s=>{if(!index_es_q(s,!1)){const{message:i}=dist_index_es_te("MISSING_OR_INVALID",`pairing topic should be a string: ${s}`);throw new Error(i)}if(!this.pairings.keys.includes(s)){const{message:i}=dist_index_es_te("NO_MATCHING_KEY",`pairing topic doesn't exist: ${s}`);throw new Error(i)}if(index_es_go(this.pairings.get(s).expiry)){await this.deletePairing(s);const{message:i}=dist_index_es_te("EXPIRED",`pairing topic: ${s}`);throw new Error(i)}}),this.core=e,this.logger=dist_index_es_E(t,this.name),this.pairings=new index_es_zi(this.core,this.logger,this.name,this.storagePrefix)}get context(){return index_es_y(this.logger)}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}registerRelayerEvents(){this.core.relayer.on(core_dist_index_es_C.message,async e=>{const{topic:t,message:s,transportType:i}=e;if(this.pairings.keys.includes(t)&&i!==dist_index_es_Q.link_mode&&!this.ignoredPayloadTypes.includes(this.core.crypto.getPayloadType(s)))try{const n=await this.core.crypto.decode(t,s);isJsonRpcRequest(n)?(this.core.history.set(t,n),await this.onRelayEventRequest({topic:t,payload:n})):isJsonRpcResponse(n)&&(await this.core.history.resolve(n),await this.onRelayEventResponse({topic:t,payload:n}),this.core.history.delete(t,n.id)),await this.core.relayer.messages.ack(t,s)}catch(n){this.logger.error(n)}})}registerExpirerEvents(){this.core.expirer.on(index_es_F.expired,async e=>{const{topic:t}=index_es_ho(e.target);t&&this.pairings.keys.includes(t)&&(await this.deletePairing(t,!0),this.events.emit(index_es_se.expire,{topic:t}))})}}var dist_index_es_Lo=Object.defineProperty,dist_index_es_ko=(r,e,t)=>e in r?dist_index_es_Lo(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,dist_index_es_R=(r,e,t)=>dist_index_es_ko(r,typeof e!="symbol"?e+"":e,t);class index_es_ki extends index_es_I{constructor(e,t){super(e,t),this.core=e,this.logger=t,dist_index_es_R(this,"records",new Map),dist_index_es_R(this,"events",new external_events_.EventEmitter),dist_index_es_R(this,"name",dist_index_es_Bt),dist_index_es_R(this,"version",dist_index_es_Vt),dist_index_es_R(this,"cached",[]),dist_index_es_R(this,"initialized",!1),dist_index_es_R(this,"storagePrefix",index_es_B),dist_index_es_R(this,"init",async()=>{this.initialized||(this.logger.trace("Initialized"),await this.restore(),this.cached.forEach(s=>this.records.set(s.id,s)),this.cached=[],this.registerEventListeners(),this.initialized=!0)}),dist_index_es_R(this,"set",(s,i,n)=>{if(this.isInitialized(),this.logger.debug("Setting JSON-RPC request history record"),this.logger.trace({type:"method",method:"set",topic:s,request:i,chainId:n}),this.records.has(i.id))return;const o={id:i.id,topic:s,request:{method:i.method,params:i.params||null},chainId:n,expiry:index_es_po(cjs.THIRTY_DAYS)};this.records.set(o.id,o),this.persist(),this.events.emit(core_dist_index_es_M.created,o)}),dist_index_es_R(this,"resolve",async s=>{if(this.isInitialized(),this.logger.debug("Updating JSON-RPC response history record"),this.logger.trace({type:"method",method:"update",response:s}),!this.records.has(s.id))return;const i=await this.getRecord(s.id);typeof i.response>"u"&&(i.response=isJsonRpcError(s)?{error:s.error}:{result:s.result},this.records.set(i.id,i),this.persist(),this.events.emit(core_dist_index_es_M.updated,i))}),dist_index_es_R(this,"get",async(s,i)=>(this.isInitialized(),this.logger.debug("Getting record"),this.logger.trace({type:"method",method:"get",topic:s,id:i}),await this.getRecord(i))),dist_index_es_R(this,"delete",(s,i)=>{this.isInitialized(),this.logger.debug("Deleting record"),this.logger.trace({type:"method",method:"delete",id:i}),this.values.forEach(n=>{if(n.topic===s){if(typeof i<"u"&&n.id!==i)return;this.records.delete(n.id),this.events.emit(core_dist_index_es_M.deleted,n)}}),this.persist()}),dist_index_es_R(this,"exists",async(s,i)=>(this.isInitialized(),this.records.has(i)?(await this.getRecord(i)).topic===s:!1)),dist_index_es_R(this,"on",(s,i)=>{this.events.on(s,i)}),dist_index_es_R(this,"once",(s,i)=>{this.events.once(s,i)}),dist_index_es_R(this,"off",(s,i)=>{this.events.off(s,i)}),dist_index_es_R(this,"removeListener",(s,i)=>{this.events.removeListener(s,i)}),this.logger=dist_index_es_E(t,this.name)}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name}get size(){return this.records.size}get keys(){return Array.from(this.records.keys())}get values(){return Array.from(this.records.values())}get pending(){const e=[];return this.values.forEach(t=>{if(typeof t.response<"u")return;const s={topic:t.topic,request:formatJsonRpcRequest(t.request.method,t.request.params,t.id),chainId:t.chainId};return e.push(s)}),e}async setJsonRpcRecords(e){await this.core.storage.setItem(this.storageKey,e)}async getJsonRpcRecords(){return await this.core.storage.getItem(this.storageKey)}getRecord(e){this.isInitialized();const t=this.records.get(e);if(!t){const{message:s}=dist_index_es_te("NO_MATCHING_KEY",`${this.name}: ${e}`);throw new Error(s)}return t}async persist(){await this.setJsonRpcRecords(this.values),this.events.emit(core_dist_index_es_M.sync)}async restore(){try{const e=await this.getJsonRpcRecords();if(typeof e>"u"||!e.length)return;if(this.records.size){const{message:t}=dist_index_es_te("RESTORE_WILL_OVERRIDE",this.name);throw this.logger.error(t),new Error(t)}this.cached=e,this.logger.debug(`Successfully Restored records for ${this.name}`),this.logger.trace({type:"method",method:"restore",records:this.values})}catch(e){this.logger.debug(`Failed to Restore records for ${this.name}`),this.logger.error(e)}}registerEventListeners(){this.events.on(core_dist_index_es_M.created,e=>{const t=core_dist_index_es_M.created;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,record:e})}),this.events.on(core_dist_index_es_M.updated,e=>{const t=core_dist_index_es_M.updated;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,record:e})}),this.events.on(core_dist_index_es_M.deleted,e=>{const t=core_dist_index_es_M.deleted;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,record:e})}),this.core.heartbeat.on(r.pulse,()=>{this.cleanup()})}cleanup(){try{this.isInitialized();let e=!1;this.records.forEach(t=>{(0,cjs.toMiliseconds)(t.expiry||0)-Date.now()<=0&&(this.logger.info(`Deleting expired history log: ${t.id}`),this.records.delete(t.id),this.events.emit(core_dist_index_es_M.deleted,t,!1),e=!0)}),e&&this.persist()}catch(e){this.logger.warn(e)}}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_jo=Object.defineProperty,dist_index_es_Uo=(r,e,t)=>e in r?dist_index_es_jo(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_A=(r,e,t)=>dist_index_es_Uo(r,typeof e!="symbol"?e+"":e,t);class index_es_ji extends dist_index_es_S{constructor(e,t){super(e,t),this.core=e,this.logger=t,index_es_A(this,"expirations",new Map),index_es_A(this,"events",new external_events_.EventEmitter),index_es_A(this,"name",dist_index_es_qt),index_es_A(this,"version",dist_index_es_Gt),index_es_A(this,"cached",[]),index_es_A(this,"initialized",!1),index_es_A(this,"storagePrefix",index_es_B),index_es_A(this,"init",async()=>{this.initialized||(this.logger.trace("Initialized"),await this.restore(),this.cached.forEach(s=>this.expirations.set(s.target,s)),this.cached=[],this.registerEventListeners(),this.initialized=!0)}),index_es_A(this,"has",s=>{try{const i=this.formatTarget(s);return typeof this.getExpiration(i)<"u"}catch{return!1}}),index_es_A(this,"set",(s,i)=>{this.isInitialized();const n=this.formatTarget(s),o={target:n,expiry:i};this.expirations.set(n,o),this.checkExpiry(n,o),this.events.emit(index_es_F.created,{target:n,expiration:o})}),index_es_A(this,"get",s=>{this.isInitialized();const i=this.formatTarget(s);return this.getExpiration(i)}),index_es_A(this,"del",s=>{if(this.isInitialized(),this.has(s)){const i=this.formatTarget(s),n=this.getExpiration(i);this.expirations.delete(i),this.events.emit(index_es_F.deleted,{target:i,expiration:n})}}),index_es_A(this,"on",(s,i)=>{this.events.on(s,i)}),index_es_A(this,"once",(s,i)=>{this.events.once(s,i)}),index_es_A(this,"off",(s,i)=>{this.events.off(s,i)}),index_es_A(this,"removeListener",(s,i)=>{this.events.removeListener(s,i)}),this.logger=dist_index_es_E(t,this.name)}get context(){return index_es_y(this.logger)}get storageKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//"+this.name}get length(){return this.expirations.size}get keys(){return Array.from(this.expirations.keys())}get values(){return Array.from(this.expirations.values())}formatTarget(e){if(typeof e=="string")return index_es_fo(e);if(typeof e=="number")return index_es_lo(e);const{message:t}=dist_index_es_te("UNKNOWN_TYPE",`Target type: ${typeof e}`);throw new Error(t)}async setExpirations(e){await this.core.storage.setItem(this.storageKey,e)}async getExpirations(){return await this.core.storage.getItem(this.storageKey)}async persist(){await this.setExpirations(this.values),this.events.emit(index_es_F.sync)}async restore(){try{const e=await this.getExpirations();if(typeof e>"u"||!e.length)return;if(this.expirations.size){const{message:t}=dist_index_es_te("RESTORE_WILL_OVERRIDE",this.name);throw this.logger.error(t),new Error(t)}this.cached=e,this.logger.debug(`Successfully Restored expirations for ${this.name}`),this.logger.trace({type:"method",method:"restore",expirations:this.values})}catch(e){this.logger.debug(`Failed to Restore expirations for ${this.name}`),this.logger.error(e)}}getExpiration(e){const t=this.expirations.get(e);if(!t){const{message:s}=dist_index_es_te("NO_MATCHING_KEY",`${this.name}: ${e}`);throw this.logger.warn(s),new Error(s)}return t}checkExpiry(e,t){const{expiry:s}=t;(0,cjs.toMiliseconds)(s)-Date.now()<=0&&this.expire(e,t)}expire(e,t){this.expirations.delete(e),this.events.emit(index_es_F.expired,{target:e,expiration:t})}checkExpirations(){this.core.relayer.connected&&this.expirations.forEach((e,t)=>this.checkExpiry(t,e))}registerEventListeners(){this.core.heartbeat.on(r.pulse,()=>this.checkExpirations()),this.events.on(index_es_F.created,e=>{const t=index_es_F.created;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,data:e}),this.persist()}),this.events.on(index_es_F.expired,e=>{const t=index_es_F.expired;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,data:e}),this.persist()}),this.events.on(index_es_F.deleted,e=>{const t=index_es_F.deleted;this.logger.info(`Emitting ${t}`),this.logger.debug({type:"event",event:t,data:e}),this.persist()})}isInitialized(){if(!this.initialized){const{message:e}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(e)}}}var dist_index_es_Mo=Object.defineProperty,dist_index_es_Fo=(r,e,t)=>e in r?dist_index_es_Mo(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,core_dist_index_es_w=(r,e,t)=>dist_index_es_Fo(r,typeof e!="symbol"?e+"":e,t);class index_es_Ui extends dist_index_es_M{constructor(e,t,s){super(e,t,s),this.core=e,this.logger=t,this.store=s,core_dist_index_es_w(this,"name",dist_index_es_Wt),core_dist_index_es_w(this,"abortController"),core_dist_index_es_w(this,"isDevEnv"),core_dist_index_es_w(this,"verifyUrlV3",dist_index_es_Yt),core_dist_index_es_w(this,"storagePrefix",index_es_B),core_dist_index_es_w(this,"version",dist_index_es_Le),core_dist_index_es_w(this,"publicKey"),core_dist_index_es_w(this,"fetchPromise"),core_dist_index_es_w(this,"init",async()=>{var i;this.isDevEnv||(this.publicKey=await this.store.getItem(this.storeKey),this.publicKey&&(0,cjs.toMiliseconds)((i=this.publicKey)==null?void 0:i.expiresAt)<Date.now()&&(this.logger.debug("verify v2 public key expired"),await this.removePublicKey()))}),core_dist_index_es_w(this,"register",async i=>{if(!index_es_Ae()||this.isDevEnv)return;const n=window.location.origin,{id:o,decryptedId:a}=i,c=`${this.verifyUrlV3}/attestation?projectId=${this.core.projectId}&origin=${n}&id=${o}&decryptedId=${a}`;try{const h=(0,dist_cjs.getDocument)(),u=this.startAbortTimer(cjs.ONE_SECOND*5),d=await new Promise((g,_)=>{const l=()=>{window.removeEventListener("message",x),h.body.removeChild(b),_("attestation aborted")};this.abortController.signal.addEventListener("abort",l);const b=h.createElement("iframe");b.src=c,b.style.display="none",b.addEventListener("error",l,{signal:this.abortController.signal});const x=I=>{if(I.data&&typeof I.data=="string")try{const D=JSON.parse(I.data);if(D.type==="verify_attestation"){if(sn(D.attestation).payload.id!==o)return;clearInterval(u),h.body.removeChild(b),this.abortController.signal.removeEventListener("abort",l),window.removeEventListener("message",x),g(D.attestation===null?"":D.attestation)}}catch(D){this.logger.warn(D)}};h.body.appendChild(b),window.addEventListener("message",x,{signal:this.abortController.signal})});return this.logger.debug("jwt attestation",d),d}catch(h){this.logger.warn(h)}return""}),core_dist_index_es_w(this,"resolve",async i=>{if(this.isDevEnv)return"";const{attestationId:n,hash:o,encryptedId:a}=i;if(n===""){this.logger.debug("resolve: attestationId is empty, skipping");return}if(n){if(sn(n).payload.id!==a)return;const h=await this.isValidJwtAttestation(n);if(h){if(!h.isVerified){this.logger.warn("resolve: jwt attestation: origin url not verified");return}return h}}if(!o)return;const c=this.getVerifyUrl(i?.verifyUrl);return this.fetchAttestation(o,c)}),core_dist_index_es_w(this,"fetchAttestation",async(i,n)=>{this.logger.debug(`resolving attestation: ${i} from url: ${n}`);const o=this.startAbortTimer(cjs.ONE_SECOND*5),a=await fetch(`${n}/attestation/${i}?v2Supported=true`,{signal:this.abortController.signal});return clearTimeout(o),a.status===200?await a.json():void 0}),core_dist_index_es_w(this,"getVerifyUrl",i=>{let n=i||index_es_ue;return dist_index_es_Jt.includes(n)||(this.logger.info(`verify url: ${n}, not included in trusted list, assigning default: ${index_es_ue}`),n=index_es_ue),n}),core_dist_index_es_w(this,"fetchPublicKey",async()=>{try{this.logger.debug(`fetching public key from: ${this.verifyUrlV3}`);const i=this.startAbortTimer(cjs.FIVE_SECONDS),n=await fetch(`${this.verifyUrlV3}/public-key`,{signal:this.abortController.signal});return clearTimeout(i),await n.json()}catch(i){this.logger.warn(i)}}),core_dist_index_es_w(this,"persistPublicKey",async i=>{this.logger.debug("persisting public key to local storage",i),await this.store.setItem(this.storeKey,i),this.publicKey=i}),core_dist_index_es_w(this,"removePublicKey",async()=>{this.logger.debug("removing verify v2 public key from storage"),await this.store.removeItem(this.storeKey),this.publicKey=void 0}),core_dist_index_es_w(this,"isValidJwtAttestation",async i=>{const n=await this.getPublicKey();try{if(n)return this.validateAttestation(i,n)}catch(a){this.logger.error(a),this.logger.warn("error validating attestation")}const o=await this.fetchAndPersistPublicKey();try{if(o)return this.validateAttestation(i,o)}catch(a){this.logger.error(a),this.logger.warn("error validating attestation")}}),core_dist_index_es_w(this,"getPublicKey",async()=>this.publicKey?this.publicKey:await this.fetchAndPersistPublicKey()),core_dist_index_es_w(this,"fetchAndPersistPublicKey",async()=>{if(this.fetchPromise)return await this.fetchPromise,this.publicKey;this.fetchPromise=new Promise(async n=>{const o=await this.fetchPublicKey();o&&(await this.persistPublicKey(o),n(o))});const i=await this.fetchPromise;return this.fetchPromise=void 0,i}),core_dist_index_es_w(this,"validateAttestation",(i,n)=>{const o=mi(i,n.publicKey),a={hasExpired:(0,cjs.toMiliseconds)(o.exp)<Date.now(),payload:o};if(a.hasExpired)throw this.logger.warn("resolve: jwt attestation expired"),new Error("JWT attestation expired");return{origin:a.payload.origin,isScam:a.payload.isScam,isVerified:a.payload.isVerified}}),this.logger=dist_index_es_E(t,this.name),this.abortController=new AbortController,this.isDevEnv=index_es_vo(),this.init()}get storeKey(){return this.storagePrefix+this.version+this.core.customStoragePrefix+"//verify:public:key"}get context(){return index_es_y(this.logger)}startAbortTimer(e){return this.abortController=new AbortController,setTimeout(()=>this.abortController.abort(),(0,cjs.toMiliseconds)(e))}}var dist_index_es_Ko=Object.defineProperty,dist_index_es_Bo=(r,e,t)=>e in r?dist_index_es_Ko(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_Mi=(r,e,t)=>dist_index_es_Bo(r,typeof e!="symbol"?e+"":e,t);class index_es_Fi extends dist_index_es_O{constructor(e,t){super(e,t),this.projectId=e,this.logger=t,index_es_Mi(this,"context",dist_index_es_Xt),index_es_Mi(this,"registerDeviceToken",async s=>{const{clientId:i,token:n,notificationType:o,enableEncrypted:a=!1}=s,c=`${dist_index_es_Zt}/${this.projectId}/clients`;await fetch(c,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:i,type:o,token:n,always_raw:a})})}),this.logger=dist_index_es_E(t,this.context)}}var dist_index_es_Vo=Object.defineProperty,index_es_Ki=Object.getOwnPropertySymbols,dist_index_es_qo=Object.prototype.hasOwnProperty,dist_index_es_Go=Object.prototype.propertyIsEnumerable,dist_index_es_Ze=(r,e,t)=>e in r?dist_index_es_Vo(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,dist_index_es_be=(r,e)=>{for(var t in e||(e={}))dist_index_es_qo.call(e,t)&&dist_index_es_Ze(r,t,e[t]);if(index_es_Ki)for(var t of index_es_Ki(e))dist_index_es_Go.call(e,t)&&dist_index_es_Ze(r,t,e[t]);return r},core_dist_index_es_E=(r,e,t)=>dist_index_es_Ze(r,typeof e!="symbol"?e+"":e,t);class index_es_Bi extends index_es_R{constructor(e,t,s=!0){super(e,t,s),this.core=e,this.logger=t,core_dist_index_es_E(this,"context",index_es_ei),core_dist_index_es_E(this,"storagePrefix",index_es_B),core_dist_index_es_E(this,"storageVersion",dist_index_es_Qt),core_dist_index_es_E(this,"events",new Map),core_dist_index_es_E(this,"shouldPersist",!1),core_dist_index_es_E(this,"init",async()=>{if(!index_es_vo())try{const i={eventId:index_es_Eo(),timestamp:Date.now(),domain:this.getAppDomain(),props:{event:"INIT",type:"",properties:{client_id:await this.core.crypto.getClientId(),user_agent:index_es_Yt(this.core.relayer.protocol,this.core.relayer.version,core_dist_index_es_e)}}};await this.sendEvent([i])}catch(i){this.logger.warn(i)}}),core_dist_index_es_E(this,"createEvent",i=>{const{event:n="ERROR",type:o="",properties:{topic:a,trace:c}}=i,h=index_es_Eo(),u=this.core.projectId||"",d=Date.now(),g=dist_index_es_be({eventId:h,timestamp:d,props:{event:n,type:o,properties:{topic:a,trace:c}},bundleId:u,domain:this.getAppDomain()},this.setMethods(h));return this.telemetryEnabled&&(this.events.set(h,g),this.shouldPersist=!0),g}),core_dist_index_es_E(this,"getEvent",i=>{const{eventId:n,topic:o}=i;if(n)return this.events.get(n);const a=Array.from(this.events.values()).find(c=>c.props.properties.topic===o);if(a)return dist_index_es_be(dist_index_es_be({},a),this.setMethods(a.eventId))}),core_dist_index_es_E(this,"deleteEvent",i=>{const{eventId:n}=i;this.events.delete(n),this.shouldPersist=!0}),core_dist_index_es_E(this,"setEventListeners",()=>{this.core.heartbeat.on(r.pulse,async()=>{this.shouldPersist&&await this.persist(),this.events.forEach(i=>{(0,cjs.fromMiliseconds)(Date.now())-(0,cjs.fromMiliseconds)(i.timestamp)>index_es_ti&&(this.events.delete(i.eventId),this.shouldPersist=!0)})})}),core_dist_index_es_E(this,"setMethods",i=>({addTrace:n=>this.addTrace(i,n),setError:n=>this.setError(i,n)})),core_dist_index_es_E(this,"addTrace",(i,n)=>{const o=this.events.get(i);o&&(o.props.properties.trace.push(n),this.events.set(i,o),this.shouldPersist=!0)}),core_dist_index_es_E(this,"setError",(i,n)=>{const o=this.events.get(i);o&&(o.props.type=n,o.timestamp=Date.now(),this.events.set(i,o),this.shouldPersist=!0)}),core_dist_index_es_E(this,"persist",async()=>{await this.core.storage.setItem(this.storageKey,Array.from(this.events.values())),this.shouldPersist=!1}),core_dist_index_es_E(this,"restore",async()=>{try{const i=await this.core.storage.getItem(this.storageKey)||[];if(!i.length)return;i.forEach(n=>{this.events.set(n.eventId,dist_index_es_be(dist_index_es_be({},n),this.setMethods(n.eventId)))})}catch(i){this.logger.warn(i)}}),core_dist_index_es_E(this,"submit",async()=>{if(!this.telemetryEnabled||this.events.size===0)return;const i=[];for(const[n,o]of this.events)o.props.type&&i.push(o);if(i.length!==0)try{if((await this.sendEvent(i)).ok)for(const n of i)this.events.delete(n.eventId),this.shouldPersist=!0}catch(n){this.logger.warn(n)}}),core_dist_index_es_E(this,"sendEvent",async i=>{const n=this.getAppDomain()?"":"&sp=desktop";return await fetch(`${index_es_ii}?projectId=${this.core.projectId}&st=events_sdk&sv=js-${core_dist_index_es_e}${n}`,{method:"POST",body:JSON.stringify(i)})}),core_dist_index_es_E(this,"getAppDomain",()=>index_es_Xr().url),this.logger=dist_index_es_E(t,this.context),this.telemetryEnabled=s,s?this.restore().then(async()=>{await this.submit(),this.setEventListeners()}):this.persist()}get storageKey(){return this.storagePrefix+this.storageVersion+this.core.customStoragePrefix+"//"+this.context}}var dist_index_es_Wo=Object.defineProperty,index_es_Vi=Object.getOwnPropertySymbols,dist_index_es_Ho=Object.prototype.hasOwnProperty,dist_index_es_Yo=Object.prototype.propertyIsEnumerable,dist_index_es_Qe=(r,e,t)=>e in r?dist_index_es_Wo(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t,index_es_qi=(r,e)=>{for(var t in e||(e={}))dist_index_es_Ho.call(e,t)&&dist_index_es_Qe(r,t,e[t]);if(index_es_Vi)for(var t of index_es_Vi(e))dist_index_es_Yo.call(e,t)&&dist_index_es_Qe(r,t,e[t]);return r},core_dist_index_es_v=(r,e,t)=>dist_index_es_Qe(r,typeof e!="symbol"?e+"":e,t);class dist_index_es_Te extends dist_index_es_h{constructor(e){var t;super(e),core_dist_index_es_v(this,"protocol",index_es_ze),core_dist_index_es_v(this,"version",dist_index_es_Le),core_dist_index_es_v(this,"name",index_es_he),core_dist_index_es_v(this,"relayUrl"),core_dist_index_es_v(this,"projectId"),core_dist_index_es_v(this,"customStoragePrefix"),core_dist_index_es_v(this,"events",new external_events_.EventEmitter),core_dist_index_es_v(this,"logger"),core_dist_index_es_v(this,"heartbeat"),core_dist_index_es_v(this,"relayer"),core_dist_index_es_v(this,"crypto"),core_dist_index_es_v(this,"storage"),core_dist_index_es_v(this,"history"),core_dist_index_es_v(this,"expirer"),core_dist_index_es_v(this,"pairing"),core_dist_index_es_v(this,"verify"),core_dist_index_es_v(this,"echoClient"),core_dist_index_es_v(this,"linkModeSupportedApps"),core_dist_index_es_v(this,"eventClient"),core_dist_index_es_v(this,"initialized",!1),core_dist_index_es_v(this,"logChunkController"),core_dist_index_es_v(this,"on",(o,a)=>this.events.on(o,a)),core_dist_index_es_v(this,"once",(o,a)=>this.events.once(o,a)),core_dist_index_es_v(this,"off",(o,a)=>this.events.off(o,a)),core_dist_index_es_v(this,"removeListener",(o,a)=>this.events.removeListener(o,a)),core_dist_index_es_v(this,"dispatchEnvelope",({topic:o,message:a,sessionExists:c})=>{if(!o||!a)return;const h={topic:o,message:a,publishedAt:Date.now(),transportType:dist_index_es_Q.link_mode};this.relayer.onLinkMessageEvent(h,{sessionExists:c})}),this.projectId=e?.projectId,this.relayUrl=e?.relayUrl||dist_index_es_Ue,this.customStoragePrefix=e!=null&&e.customStoragePrefix?`:${e.customStoragePrefix}`:"";const s=logger_dist_index_es_k({level:typeof e?.logger=="string"&&e.logger?e.logger:dist_index_es_Et.logger,name:index_es_he}),{logger:i,chunkLoggerController:n}=A({opts:s,maxSizeInBytes:e?.maxLogBlobSizeInBytes,loggerOverride:e?.logger});this.logChunkController=n,(t=this.logChunkController)!=null&&t.downloadLogsBlobInBrowser&&(window.downloadLogsBlobInBrowser=async()=>{var o,a;(o=this.logChunkController)!=null&&o.downloadLogsBlobInBrowser&&((a=this.logChunkController)==null||a.downloadLogsBlobInBrowser({clientId:await this.crypto.getClientId()}))}),this.logger=dist_index_es_E(i,this.name),this.heartbeat=new index_es_i,this.crypto=new index_es_vi(this,this.logger,e?.keychain),this.history=new index_es_ki(this,this.logger),this.expirer=new index_es_ji(this,this.logger),this.storage=e!=null&&e.storage?e.storage:new index_es_h(index_es_qi(index_es_qi({},dist_index_es_It),e?.storageOptions)),this.relayer=new index_es_Si({core:this,logger:this.logger,relayUrl:this.relayUrl,projectId:this.projectId}),this.pairing=new index_es_Li(this,this.logger),this.verify=new index_es_Ui(this,this.logger,this.storage),this.echoClient=new index_es_Fi(this.projectId||"",this.logger),this.linkModeSupportedApps=[],this.eventClient=new index_es_Bi(this,this.logger,e?.telemetryEnabled)}static async init(e){const t=new dist_index_es_Te(e);await t.initialize();const s=await t.crypto.getClientId();return await t.storage.setItem(index_es_jt,s),t}get context(){return index_es_y(this.logger)}async start(){this.initialized||await this.initialize()}async getLogsBlob(){var e;return(e=this.logChunkController)==null?void 0:e.logsToBlob({clientId:await this.crypto.getClientId()})}async addLinkModeSupportedApp(e){this.linkModeSupportedApps.includes(e)||(this.linkModeSupportedApps.push(e),await this.storage.setItem(dist_index_es_Me,this.linkModeSupportedApps))}async initialize(){this.logger.trace("Initialized");try{await this.crypto.init(),await this.history.init(),await this.expirer.init(),await this.relayer.init(),await this.heartbeat.init(),await this.pairing.init(),this.linkModeSupportedApps=await this.storage.getItem(dist_index_es_Me)||[],this.initialized=!0,this.logger.info("Core Initialization Success")}catch(e){throw this.logger.warn(`Core Initialization Failure at epoch ${Date.now()}`,e),this.logger.error(e.message),e}}}const dist_index_es_Jo=dist_index_es_Te;
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/sign-client/dist/index.es.js
const dist_index_es_De="wc",sign_client_dist_index_es_Le=2,sign_client_dist_index_es_ke="client",dist_index_es_we=`${dist_index_es_De}@${sign_client_dist_index_es_Le}:${sign_client_dist_index_es_ke}:`,dist_index_es_me={name:sign_client_dist_index_es_ke,logger:"error",controller:!1,relayUrl:"wss://relay.walletconnect.org"},index_es_ys={session_proposal:"session_proposal",session_update:"session_update",session_extend:"session_extend",session_ping:"session_ping",session_delete:"session_delete",session_expire:"session_expire",session_request:"session_request",session_request_sent:"session_request_sent",session_event:"session_event",proposal_expire:"proposal_expire",session_authenticate:"session_authenticate",session_request_expire:"session_request_expire",session_connect:"session_connect"},index_es_ws={database:":memory:"},sign_client_dist_index_es_Me="WALLETCONNECT_DEEPLINK_CHOICE",index_es_ms={created:"history_created",updated:"history_updated",deleted:"history_deleted",sync:"history_sync"},index_es_s="history",index_es_Es="0.3",index_es_pt="proposal",index_es_fs=(/* unused pure expression or super */ null && (kt)),dist_index_es_$e="Proposal expired",dist_index_es_ht="session",sign_client_dist_index_es_J=cjs.SEVEN_DAYS,dist_index_es_dt="engine",dist_index_es_N={wc_sessionPropose:{req:{ttl:cjs.FIVE_MINUTES,prompt:!0,tag:1100},res:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1101},reject:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1120},autoReject:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1121}},wc_sessionSettle:{req:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1102},res:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1103}},wc_sessionUpdate:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:1104},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:1105}},wc_sessionExtend:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:1106},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:1107}},wc_sessionRequest:{req:{ttl:cjs.FIVE_MINUTES,prompt:!0,tag:1108},res:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1109}},wc_sessionEvent:{req:{ttl:cjs.FIVE_MINUTES,prompt:!0,tag:1110},res:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1111}},wc_sessionDelete:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:1112},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:1113}},wc_sessionPing:{req:{ttl:cjs.ONE_DAY,prompt:!1,tag:1114},res:{ttl:cjs.ONE_DAY,prompt:!1,tag:1115}},wc_sessionAuthenticate:{req:{ttl:cjs.ONE_HOUR,prompt:!0,tag:1116},res:{ttl:cjs.ONE_HOUR,prompt:!1,tag:1117},reject:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1118},autoReject:{ttl:cjs.FIVE_MINUTES,prompt:!1,tag:1119}}},sign_client_dist_index_es_e={min:cjs.FIVE_MINUTES,max:cjs.SEVEN_DAYS},dist_index_es_$={idle:"IDLE",active:"ACTIVE"},sign_client_dist_index_es_Ue={eth_sendTransaction:{key:""},eth_sendRawTransaction:{key:""},wallet_sendCalls:{key:""},solana_signTransaction:{key:"signature"},solana_signAllTransactions:{key:"transactions"},solana_signAndSendTransaction:{key:"signature"}},dist_index_es_ut="request",dist_index_es_gt=["wc_sessionPropose","wc_sessionRequest","wc_authRequest","wc_sessionAuthenticate"],dist_index_es_yt="wc",index_es_Ss=1.5,dist_index_es_wt="auth",index_es_mt="authKeys",dist_index_es_t="pairingTopics",sign_client_dist_index_es_Et="requests",index_es_ae=`${dist_index_es_yt}@${1.5}:${dist_index_es_wt}:`,index_es_ce=`${index_es_ae}:PUB_KEY`;var index_es_Rs=Object.defineProperty,index_es_vs=Object.defineProperties,index_es_Is=Object.getOwnPropertyDescriptors,dist_index_es_ft=Object.getOwnPropertySymbols,index_es_Ts=Object.prototype.hasOwnProperty,dist_index_es_qs=Object.prototype.propertyIsEnumerable,sign_client_dist_index_es_Ke=(S,n,e)=>n in S?index_es_Rs(S,n,{enumerable:!0,configurable:!0,writable:!0,value:e}):S[n]=e,sign_client_dist_index_es_v=(S,n)=>{for(var e in n||(n={}))index_es_Ts.call(n,e)&&sign_client_dist_index_es_Ke(S,e,n[e]);if(dist_index_es_ft)for(var e of dist_index_es_ft(n))dist_index_es_qs.call(n,e)&&sign_client_dist_index_es_Ke(S,e,n[e]);return S},sign_client_dist_index_es_b=(S,n)=>index_es_vs(S,index_es_Is(n)),sign_client_dist_index_es_c=(S,n,e)=>sign_client_dist_index_es_Ke(S,typeof n!="symbol"?n+"":n,e);class index_es_Ps extends index_es_V{constructor(n){super(n),sign_client_dist_index_es_c(this,"name",dist_index_es_dt),sign_client_dist_index_es_c(this,"events",new (external_events_default())),sign_client_dist_index_es_c(this,"initialized",!1),sign_client_dist_index_es_c(this,"requestQueue",{state:dist_index_es_$.idle,queue:[]}),sign_client_dist_index_es_c(this,"sessionRequestQueue",{state:dist_index_es_$.idle,queue:[]}),sign_client_dist_index_es_c(this,"requestQueueDelay",cjs.ONE_SECOND),sign_client_dist_index_es_c(this,"expectedPairingMethodMap",new Map),sign_client_dist_index_es_c(this,"recentlyDeletedMap",new Map),sign_client_dist_index_es_c(this,"recentlyDeletedLimit",200),sign_client_dist_index_es_c(this,"relayMessageCache",[]),sign_client_dist_index_es_c(this,"pendingSessions",new Map),sign_client_dist_index_es_c(this,"init",async()=>{this.initialized||(await this.cleanup(),this.registerRelayerEvents(),this.registerExpirerEvents(),this.registerPairingEvents(),await this.registerLinkModeListeners(),this.client.core.pairing.register({methods:Object.keys(dist_index_es_N)}),this.initialized=!0,setTimeout(async()=>{await this.processPendingMessageEvents(),this.sessionRequestQueue.queue=this.getPendingSessionRequests(),this.processSessionRequestQueue()},(0,cjs.toMiliseconds)(this.requestQueueDelay)))}),sign_client_dist_index_es_c(this,"connect",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();const t=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},e),{requiredNamespaces:e.requiredNamespaces||{},optionalNamespaces:e.optionalNamespaces||{}});await this.isValidConnect(t);const{pairingTopic:s,requiredNamespaces:i,optionalNamespaces:r,sessionProperties:o,scopedProperties:a,relays:l}=t;let p=s,h,u=!1;try{if(p){const T=this.client.core.pairing.pairings.get(p);this.client.logger.warn("connect() with existing pairing topic is deprecated and will be removed in the next major release."),u=T.active}}catch(T){throw this.client.logger.error(`connect() -> pairing.get(${p}) failed`),T}if(!p||!u){const{topic:T,uri:U}=await this.client.core.pairing.create();p=T,h=U}if(!p){const{message:T}=dist_index_es_te("NO_MATCHING_KEY",`connect() pairing topic: ${p}`);throw new Error(T)}const d=await this.client.core.crypto.generateKeyPair(),w=dist_index_es_N.wc_sessionPropose.req.ttl||cjs.FIVE_MINUTES,m=index_es_po(w),f=sign_client_dist_index_es_b(sign_client_dist_index_es_v(sign_client_dist_index_es_v({requiredNamespaces:i,optionalNamespaces:r,relays:l??[{protocol:dist_index_es_xt}],proposer:{publicKey:d,metadata:this.client.metadata},expiryTimestamp:m,pairingTopic:p},o&&{sessionProperties:o}),a&&{scopedProperties:a}),{id:payloadId()}),_=index_es_yo("session_connect",f.id),{reject:g,resolve:A,done:D}=index_es_ao(w,dist_index_es_$e),I=({id:T})=>{T===f.id&&(this.client.events.off("proposal_expire",I),this.pendingSessions.delete(f.id),this.events.emit(_,{error:{message:dist_index_es_$e,code:0}}))};return this.client.events.on("proposal_expire",I),this.events.once(_,({error:T,session:U})=>{this.client.events.off("proposal_expire",I),T?g(T):U&&A(U)}),await this.sendRequest({topic:p,method:"wc_sessionPropose",params:f,throwOnFailedPublish:!0,clientRpcId:f.id}),await this.setProposal(f.id,f),{uri:h,approval:D}}),sign_client_dist_index_es_c(this,"pair",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();try{return await this.client.core.pairing.pair(e)}catch(t){throw this.client.logger.error("pair() failed"),t}}),sign_client_dist_index_es_c(this,"approve",async e=>{var t,s,i;const r=this.client.core.eventClient.createEvent({properties:{topic:(t=e?.id)==null?void 0:t.toString(),trace:[index_es_Qs.session_approve_started]}});try{this.isInitialized(),await this.confirmOnlineStateOrThrow()}catch(q){throw r.setError(dist_index_es_er.no_internet_connection),q}try{await this.isValidProposalId(e?.id)}catch(q){throw this.client.logger.error(`approve() -> proposal.get(${e?.id}) failed`),r.setError(dist_index_es_er.proposal_not_found),q}try{await this.isValidApprove(e)}catch(q){throw this.client.logger.error("approve() -> isValidApprove() failed"),r.setError(dist_index_es_er.session_approve_namespace_validation_failure),q}const{id:o,relayProtocol:a,namespaces:l,sessionProperties:p,scopedProperties:h,sessionConfig:u}=e,d=this.client.proposal.get(o);this.client.core.eventClient.deleteEvent({eventId:r.eventId});const{pairingTopic:w,proposer:m,requiredNamespaces:f,optionalNamespaces:_}=d;let g=(s=this.client.core.eventClient)==null?void 0:s.getEvent({topic:w});g||(g=(i=this.client.core.eventClient)==null?void 0:i.createEvent({type:index_es_Qs.session_approve_started,properties:{topic:w,trace:[index_es_Qs.session_approve_started,index_es_Qs.session_namespaces_validation_success]}}));const A=await this.client.core.crypto.generateKeyPair(),D=m.publicKey,I=await this.client.core.crypto.generateSharedKey(A,D),T=sign_client_dist_index_es_v(sign_client_dist_index_es_v(sign_client_dist_index_es_v({relay:{protocol:a??"irn"},namespaces:l,controller:{publicKey:A,metadata:this.client.metadata},expiry:index_es_po(sign_client_dist_index_es_J)},p&&{sessionProperties:p}),h&&{scopedProperties:h}),u&&{sessionConfig:u}),U=dist_index_es_Q.relay;g.addTrace(index_es_Qs.subscribing_session_topic);try{await this.client.core.relayer.subscribe(I,{transportType:U})}catch(q){throw g.setError(dist_index_es_er.subscribe_session_topic_failure),q}g.addTrace(index_es_Qs.subscribe_session_topic_success);const fe=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},T),{topic:I,requiredNamespaces:f,optionalNamespaces:_,pairingTopic:w,acknowledged:!1,self:T.controller,peer:{publicKey:m.publicKey,metadata:m.metadata},controller:A,transportType:dist_index_es_Q.relay});await this.client.session.set(I,fe),g.addTrace(index_es_Qs.store_session);try{g.addTrace(index_es_Qs.publishing_session_settle),await this.sendRequest({topic:I,method:"wc_sessionSettle",params:T,throwOnFailedPublish:!0}).catch(q=>{throw g?.setError(dist_index_es_er.session_settle_publish_failure),q}),g.addTrace(index_es_Qs.session_settle_publish_success),g.addTrace(index_es_Qs.publishing_session_approve),await this.sendResult({id:o,topic:w,result:{relay:{protocol:a??"irn"},responderPublicKey:A},throwOnFailedPublish:!0}).catch(q=>{throw g?.setError(dist_index_es_er.session_approve_publish_failure),q}),g.addTrace(index_es_Qs.session_approve_publish_success)}catch(q){throw this.client.logger.error(q),this.client.session.delete(I,index_es_de("USER_DISCONNECTED")),await this.client.core.relayer.unsubscribe(I),q}return this.client.core.eventClient.deleteEvent({eventId:g.eventId}),await this.client.core.pairing.updateMetadata({topic:w,metadata:m.metadata}),await this.client.proposal.delete(o,index_es_de("USER_DISCONNECTED")),await this.client.core.pairing.activate({topic:w}),await this.setExpiry(I,index_es_po(sign_client_dist_index_es_J)),{topic:I,acknowledged:()=>Promise.resolve(this.client.session.get(I))}}),sign_client_dist_index_es_c(this,"reject",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();try{await this.isValidReject(e)}catch(r){throw this.client.logger.error("reject() -> isValidReject() failed"),r}const{id:t,reason:s}=e;let i;try{i=this.client.proposal.get(t).pairingTopic}catch(r){throw this.client.logger.error(`reject() -> proposal.get(${t}) failed`),r}i&&(await this.sendError({id:t,topic:i,error:s,rpcOpts:dist_index_es_N.wc_sessionPropose.reject}),await this.client.proposal.delete(t,index_es_de("USER_DISCONNECTED")))}),sign_client_dist_index_es_c(this,"update",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();try{await this.isValidUpdate(e)}catch(h){throw this.client.logger.error("update() -> isValidUpdate() failed"),h}const{topic:t,namespaces:s}=e,{done:i,resolve:r,reject:o}=index_es_ao(),a=payloadId(),l=getBigIntRpcId().toString(),p=this.client.session.get(t).namespaces;return this.events.once(index_es_yo("session_update",a),({error:h})=>{h?o(h):r()}),await this.client.session.update(t,{namespaces:s}),await this.sendRequest({topic:t,method:"wc_sessionUpdate",params:{namespaces:s},throwOnFailedPublish:!0,clientRpcId:a,relayRpcId:l}).catch(h=>{this.client.logger.error(h),this.client.session.update(t,{namespaces:p}),o(h)}),{acknowledged:i}}),sign_client_dist_index_es_c(this,"extend",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();try{await this.isValidExtend(e)}catch(a){throw this.client.logger.error("extend() -> isValidExtend() failed"),a}const{topic:t}=e,s=payloadId(),{done:i,resolve:r,reject:o}=index_es_ao();return this.events.once(index_es_yo("session_extend",s),({error:a})=>{a?o(a):r()}),await this.setExpiry(t,index_es_po(sign_client_dist_index_es_J)),this.sendRequest({topic:t,method:"wc_sessionExtend",params:{},clientRpcId:s,throwOnFailedPublish:!0}).catch(a=>{o(a)}),{acknowledged:i}}),sign_client_dist_index_es_c(this,"request",async e=>{this.isInitialized();try{await this.isValidRequest(e)}catch(_){throw this.client.logger.error("request() -> isValidRequest() failed"),_}const{chainId:t,request:s,topic:i,expiry:r=dist_index_es_N.wc_sessionRequest.req.ttl}=e,o=this.client.session.get(i);o?.transportType===dist_index_es_Q.relay&&await this.confirmOnlineStateOrThrow();const a=payloadId(),l=getBigIntRpcId().toString(),{done:p,resolve:h,reject:u}=index_es_ao(r,"Request expired. Please try again.");this.events.once(index_es_yo("session_request",a),({error:_,result:g})=>{_?u(_):h(g)});const d="wc_sessionRequest",w=this.getAppLinkIfEnabled(o.peer.metadata,o.transportType);if(w)return await this.sendRequest({clientRpcId:a,relayRpcId:l,topic:i,method:d,params:{request:sign_client_dist_index_es_b(sign_client_dist_index_es_v({},s),{expiryTimestamp:index_es_po(r)}),chainId:t},expiry:r,throwOnFailedPublish:!0,appLink:w}).catch(_=>u(_)),this.client.events.emit("session_request_sent",{topic:i,request:s,chainId:t,id:a}),await p();const m={request:sign_client_dist_index_es_b(sign_client_dist_index_es_v({},s),{expiryTimestamp:index_es_po(r)}),chainId:t},f=this.shouldSetTVF(d,m);return await Promise.all([new Promise(async _=>{await this.sendRequest(sign_client_dist_index_es_v({clientRpcId:a,relayRpcId:l,topic:i,method:d,params:m,expiry:r,throwOnFailedPublish:!0},f&&{tvf:this.getTVFParams(a,m)})).catch(g=>u(g)),this.client.events.emit("session_request_sent",{topic:i,request:s,chainId:t,id:a}),_()}),new Promise(async _=>{var g;if(!((g=o.sessionConfig)!=null&&g.disableDeepLink)){const A=await index_es_bo(this.client.core.storage,sign_client_dist_index_es_Me);await index_es_mo({id:a,topic:i,wcDeepLink:A})}_()}),p()]).then(_=>_[2])}),sign_client_dist_index_es_c(this,"respond",async e=>{this.isInitialized(),await this.isValidRespond(e);const{topic:t,response:s}=e,{id:i}=s,r=this.client.session.get(t);r.transportType===dist_index_es_Q.relay&&await this.confirmOnlineStateOrThrow();const o=this.getAppLinkIfEnabled(r.peer.metadata,r.transportType);isJsonRpcResult(s)?await this.sendResult({id:i,topic:t,result:s.result,throwOnFailedPublish:!0,appLink:o}):isJsonRpcError(s)&&await this.sendError({id:i,topic:t,error:s.error,appLink:o}),this.cleanupAfterResponse(e)}),sign_client_dist_index_es_c(this,"ping",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow();try{await this.isValidPing(e)}catch(s){throw this.client.logger.error("ping() -> isValidPing() failed"),s}const{topic:t}=e;if(this.client.session.keys.includes(t)){const s=payloadId(),i=getBigIntRpcId().toString(),{done:r,resolve:o,reject:a}=index_es_ao();this.events.once(index_es_yo("session_ping",s),({error:l})=>{l?a(l):o()}),await Promise.all([this.sendRequest({topic:t,method:"wc_sessionPing",params:{},throwOnFailedPublish:!0,clientRpcId:s,relayRpcId:i}),r()])}else this.client.core.pairing.pairings.keys.includes(t)&&(this.client.logger.warn("ping() on pairing topic is deprecated and will be removed in the next major release."),await this.client.core.pairing.ping({topic:t}))}),sign_client_dist_index_es_c(this,"emit",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow(),await this.isValidEmit(e);const{topic:t,event:s,chainId:i}=e,r=getBigIntRpcId().toString(),o=payloadId();await this.sendRequest({topic:t,method:"wc_sessionEvent",params:{event:s,chainId:i},throwOnFailedPublish:!0,relayRpcId:r,clientRpcId:o})}),sign_client_dist_index_es_c(this,"disconnect",async e=>{this.isInitialized(),await this.confirmOnlineStateOrThrow(),await this.isValidDisconnect(e);const{topic:t}=e;if(this.client.session.keys.includes(t))await this.sendRequest({topic:t,method:"wc_sessionDelete",params:index_es_de("USER_DISCONNECTED"),throwOnFailedPublish:!0}),await this.deleteSession({topic:t,emitEvent:!1});else if(this.client.core.pairing.pairings.keys.includes(t))await this.client.core.pairing.disconnect({topic:t});else{const{message:s}=dist_index_es_te("MISMATCHED_TOPIC",`Session or pairing topic not found: ${t}`);throw new Error(s)}}),sign_client_dist_index_es_c(this,"find",e=>(this.isInitialized(),this.client.session.getAll().filter(t=>Pi(t,e)))),sign_client_dist_index_es_c(this,"getPendingSessionRequests",()=>this.client.pendingRequest.getAll()),sign_client_dist_index_es_c(this,"authenticate",async(e,t)=>{var s;this.isInitialized(),this.isValidAuthenticate(e);const i=t&&this.client.core.linkModeSupportedApps.includes(t)&&((s=this.client.metadata.redirect)==null?void 0:s.linkMode),r=i?dist_index_es_Q.link_mode:dist_index_es_Q.relay;r===dist_index_es_Q.relay&&await this.confirmOnlineStateOrThrow();const{chains:o,statement:a="",uri:l,domain:p,nonce:h,type:u,exp:d,nbf:w,methods:m=[],expiry:f}=e,_=[...e.resources||[]],{topic:g,uri:A}=await this.client.core.pairing.create({methods:["wc_sessionAuthenticate"],transportType:r});this.client.logger.info({message:"Generated new pairing",pairing:{topic:g,uri:A}});const D=await this.client.core.crypto.generateKeyPair(),I=ii(D);if(await Promise.all([this.client.auth.authKeys.set(index_es_ce,{responseTopic:I,publicKey:D}),this.client.auth.pairingTopics.set(I,{topic:I,pairingTopic:g})]),await this.client.core.relayer.subscribe(I,{transportType:r}),this.client.logger.info(`sending request to new pairing topic: ${g}`),m.length>0){const{namespace:x}=index_es_Ye(o[0]);let L=rs(x,"request",m);index_es_Me(_)&&(L=os(L,_.pop())),_.push(L)}const T=f&&f>dist_index_es_N.wc_sessionAuthenticate.req.ttl?f:dist_index_es_N.wc_sessionAuthenticate.req.ttl,U={authPayload:{type:u??"caip122",chains:o,statement:a,aud:l,domain:p,version:"1",nonce:h,iat:new Date().toISOString(),exp:d,nbf:w,resources:_},requester:{publicKey:D,metadata:this.client.metadata},expiryTimestamp:index_es_po(T)},fe={eip155:{chains:o,methods:[...new Set(["personal_sign",...m])],events:["chainChanged","accountsChanged"]}},q={requiredNamespaces:{},optionalNamespaces:fe,relays:[{protocol:"irn"}],pairingTopic:g,proposer:{publicKey:D,metadata:this.client.metadata},expiryTimestamp:index_es_po(dist_index_es_N.wc_sessionPropose.req.ttl),id:payloadId()},{done:Rt,resolve:je,reject:Se}=index_es_ao(T,"Request expired"),te=payloadId(),le=index_es_yo("session_connect",q.id),Re=index_es_yo("session_request",te),pe=async({error:x,session:L})=>{this.events.off(Re,ve),x?Se(x):L&&je({session:L})},ve=async x=>{var L,Fe,Qe;if(await this.deletePendingAuthRequest(te,{message:"fulfilled",code:0}),x.error){const ie=index_es_de("WC_METHOD_UNSUPPORTED","wc_sessionAuthenticate");return x.error.code===ie.code?void 0:(this.events.off(le,pe),Se(x.error.message))}await this.deleteProposal(q.id),this.events.off(le,pe);const{cacaos:He,responder:Q}=x.result,Te=[],ze=[];for(const ie of He){await index_es_Zo({cacao:ie,projectId:this.client.core.projectId})||(this.client.logger.error(ie,"Signature verification failed"),Se(index_es_de("SESSION_SETTLEMENT_FAILED","Signature verification failed")));const{p:qe}=ie,Pe=index_es_Me(qe.resources),Ye=[index_es_In(qe.iss)],vt=index_es_ut(qe.iss);if(Pe){const Ne=ss(Pe),It=is(Pe);Te.push(...Ne),Ye.push(...It)}for(const Ne of Ye)ze.push(`${Ne}:${vt}`)}const se=await this.client.core.crypto.generateSharedKey(D,Q.publicKey);let he;Te.length>0&&(he={topic:se,acknowledged:!0,self:{publicKey:D,metadata:this.client.metadata},peer:Q,controller:Q.publicKey,expiry:index_es_po(sign_client_dist_index_es_J),requiredNamespaces:{},optionalNamespaces:{},relay:{protocol:"irn"},pairingTopic:g,namespaces:Ri([...new Set(Te)],[...new Set(ze)]),transportType:r},await this.client.core.relayer.subscribe(se,{transportType:r}),await this.client.session.set(se,he),g&&await this.client.core.pairing.updateMetadata({topic:g,metadata:Q.metadata}),he=this.client.session.get(se)),(L=this.client.metadata.redirect)!=null&&L.linkMode&&(Fe=Q.metadata.redirect)!=null&&Fe.linkMode&&(Qe=Q.metadata.redirect)!=null&&Qe.universal&&t&&(this.client.core.addLinkModeSupportedApp(Q.metadata.redirect.universal),this.client.session.update(se,{transportType:dist_index_es_Q.link_mode})),je({auths:He,session:he})};this.events.once(le,pe),this.events.once(Re,ve);let Ie;try{if(i){const x=formatJsonRpcRequest("wc_sessionAuthenticate",U,te);this.client.core.history.set(g,x);const L=await this.client.core.crypto.encode("",x,{type:index_es_e,encoding:ti});Ie=xi(t,g,L)}else await Promise.all([this.sendRequest({topic:g,method:"wc_sessionAuthenticate",params:U,expiry:e.expiry,throwOnFailedPublish:!0,clientRpcId:te}),this.sendRequest({topic:g,method:"wc_sessionPropose",params:q,expiry:dist_index_es_N.wc_sessionPropose.req.ttl,throwOnFailedPublish:!0,clientRpcId:q.id})])}catch(x){throw this.events.off(le,pe),this.events.off(Re,ve),x}return await this.setProposal(q.id,q),await this.setAuthRequest(te,{request:sign_client_dist_index_es_b(sign_client_dist_index_es_v({},U),{verifyContext:{}}),pairingTopic:g,transportType:r}),{uri:Ie??A,response:Rt}}),sign_client_dist_index_es_c(this,"approveSessionAuthenticate",async e=>{const{id:t,auths:s}=e,i=this.client.core.eventClient.createEvent({properties:{topic:t.toString(),trace:[dist_index_es_tr.authenticated_session_approve_started]}});try{this.isInitialized()}catch(f){throw i.setError(dist_index_es_ir.no_internet_connection),f}const r=this.getPendingAuthRequest(t);if(!r)throw i.setError(dist_index_es_ir.authenticated_session_pending_request_not_found),new Error(`Could not find pending auth request with id ${t}`);const o=r.transportType||dist_index_es_Q.relay;o===dist_index_es_Q.relay&&await this.confirmOnlineStateOrThrow();const a=r.requester.publicKey,l=await this.client.core.crypto.generateKeyPair(),p=ii(a),h={type:index_es_Oe,receiverPublicKey:a,senderPublicKey:l},u=[],d=[];for(const f of s){if(!await index_es_Zo({cacao:f,projectId:this.client.core.projectId})){i.setError(dist_index_es_ir.invalid_cacao);const I=index_es_de("SESSION_SETTLEMENT_FAILED","Signature verification failed");throw await this.sendError({id:t,topic:p,error:I,encodeOpts:h}),new Error(I.message)}i.addTrace(dist_index_es_tr.cacaos_verified);const{p:_}=f,g=index_es_Me(_.resources),A=[index_es_In(_.iss)],D=index_es_ut(_.iss);if(g){const I=ss(g),T=is(g);u.push(...I),A.push(...T)}for(const I of A)d.push(`${I}:${D}`)}const w=await this.client.core.crypto.generateSharedKey(l,a);i.addTrace(dist_index_es_tr.create_authenticated_session_topic);let m;if(u?.length>0){m={topic:w,acknowledged:!0,self:{publicKey:l,metadata:this.client.metadata},peer:{publicKey:a,metadata:r.requester.metadata},controller:a,expiry:index_es_po(sign_client_dist_index_es_J),authentication:s,requiredNamespaces:{},optionalNamespaces:{},relay:{protocol:"irn"},pairingTopic:r.pairingTopic,namespaces:Ri([...new Set(u)],[...new Set(d)]),transportType:o},i.addTrace(dist_index_es_tr.subscribing_authenticated_session_topic);try{await this.client.core.relayer.subscribe(w,{transportType:o})}catch(f){throw i.setError(dist_index_es_ir.subscribe_authenticated_session_topic_failure),f}i.addTrace(dist_index_es_tr.subscribe_authenticated_session_topic_success),await this.client.session.set(w,m),i.addTrace(dist_index_es_tr.store_authenticated_session),await this.client.core.pairing.updateMetadata({topic:r.pairingTopic,metadata:r.requester.metadata})}i.addTrace(dist_index_es_tr.publishing_authenticated_session_approve);try{await this.sendResult({topic:p,id:t,result:{cacaos:s,responder:{publicKey:l,metadata:this.client.metadata}},encodeOpts:h,throwOnFailedPublish:!0,appLink:this.getAppLinkIfEnabled(r.requester.metadata,o)})}catch(f){throw i.setError(dist_index_es_ir.authenticated_session_approve_publish_failure),f}return await this.client.auth.requests.delete(t,{message:"fulfilled",code:0}),await this.client.core.pairing.activate({topic:r.pairingTopic}),this.client.core.eventClient.deleteEvent({eventId:i.eventId}),{session:m}}),sign_client_dist_index_es_c(this,"rejectSessionAuthenticate",async e=>{this.isInitialized();const{id:t,reason:s}=e,i=this.getPendingAuthRequest(t);if(!i)throw new Error(`Could not find pending auth request with id ${t}`);i.transportType===dist_index_es_Q.relay&&await this.confirmOnlineStateOrThrow();const r=i.requester.publicKey,o=await this.client.core.crypto.generateKeyPair(),a=ii(r),l={type:index_es_Oe,receiverPublicKey:r,senderPublicKey:o};await this.sendError({id:t,topic:a,error:s,encodeOpts:l,rpcOpts:dist_index_es_N.wc_sessionAuthenticate.reject,appLink:this.getAppLinkIfEnabled(i.requester.metadata,i.transportType)}),await this.client.auth.requests.delete(t,{message:"rejected",code:0}),await this.client.proposal.delete(t,index_es_de("USER_DISCONNECTED"))}),sign_client_dist_index_es_c(this,"formatAuthMessage",e=>{this.isInitialized();const{request:t,iss:s}=e;return index_es_On(t,s)}),sign_client_dist_index_es_c(this,"processRelayMessageCache",()=>{setTimeout(async()=>{if(this.relayMessageCache.length!==0)for(;this.relayMessageCache.length>0;)try{const e=this.relayMessageCache.shift();e&&await this.onRelayMessage(e)}catch(e){this.client.logger.error(e)}},50)}),sign_client_dist_index_es_c(this,"cleanupDuplicatePairings",async e=>{if(e.pairingTopic)try{const t=this.client.core.pairing.pairings.get(e.pairingTopic),s=this.client.core.pairing.pairings.getAll().filter(i=>{var r,o;return((r=i.peerMetadata)==null?void 0:r.url)&&((o=i.peerMetadata)==null?void 0:o.url)===e.peer.metadata.url&&i.topic&&i.topic!==t.topic});if(s.length===0)return;this.client.logger.info(`Cleaning up ${s.length} duplicate pairing(s)`),await Promise.all(s.map(i=>this.client.core.pairing.disconnect({topic:i.topic}))),this.client.logger.info("Duplicate pairings clean up finished")}catch(t){this.client.logger.error(t)}}),sign_client_dist_index_es_c(this,"deleteSession",async e=>{var t;const{topic:s,expirerHasDeleted:i=!1,emitEvent:r=!0,id:o=0}=e,{self:a}=this.client.session.get(s);await this.client.core.relayer.unsubscribe(s),await this.client.session.delete(s,index_es_de("USER_DISCONNECTED")),this.addToRecentlyDeleted(s,"session"),this.client.core.crypto.keychain.has(a.publicKey)&&await this.client.core.crypto.deleteKeyPair(a.publicKey),this.client.core.crypto.keychain.has(s)&&await this.client.core.crypto.deleteSymKey(s),i||this.client.core.expirer.del(s),this.client.core.storage.removeItem(sign_client_dist_index_es_Me).catch(l=>this.client.logger.warn(l)),this.getPendingSessionRequests().forEach(l=>{l.topic===s&&this.deletePendingSessionRequest(l.id,index_es_de("USER_DISCONNECTED"))}),s===((t=this.sessionRequestQueue.queue[0])==null?void 0:t.topic)&&(this.sessionRequestQueue.state=dist_index_es_$.idle),r&&this.client.events.emit("session_delete",{id:o,topic:s})}),sign_client_dist_index_es_c(this,"deleteProposal",async(e,t)=>{if(t)try{const s=this.client.proposal.get(e),i=this.client.core.eventClient.getEvent({topic:s.pairingTopic});i?.setError(dist_index_es_er.proposal_expired)}catch{}await Promise.all([this.client.proposal.delete(e,index_es_de("USER_DISCONNECTED")),t?Promise.resolve():this.client.core.expirer.del(e)]),this.addToRecentlyDeleted(e,"proposal")}),sign_client_dist_index_es_c(this,"deletePendingSessionRequest",async(e,t,s=!1)=>{await Promise.all([this.client.pendingRequest.delete(e,t),s?Promise.resolve():this.client.core.expirer.del(e)]),this.addToRecentlyDeleted(e,"request"),this.sessionRequestQueue.queue=this.sessionRequestQueue.queue.filter(i=>i.id!==e),s&&(this.sessionRequestQueue.state=dist_index_es_$.idle,this.client.events.emit("session_request_expire",{id:e}))}),sign_client_dist_index_es_c(this,"deletePendingAuthRequest",async(e,t,s=!1)=>{await Promise.all([this.client.auth.requests.delete(e,t),s?Promise.resolve():this.client.core.expirer.del(e)])}),sign_client_dist_index_es_c(this,"setExpiry",async(e,t)=>{this.client.session.keys.includes(e)&&(this.client.core.expirer.set(e,t),await this.client.session.update(e,{expiry:t}))}),sign_client_dist_index_es_c(this,"setProposal",async(e,t)=>{this.client.core.expirer.set(e,index_es_po(dist_index_es_N.wc_sessionPropose.req.ttl)),await this.client.proposal.set(e,t)}),sign_client_dist_index_es_c(this,"setAuthRequest",async(e,t)=>{const{request:s,pairingTopic:i,transportType:r=dist_index_es_Q.relay}=t;this.client.core.expirer.set(e,s.expiryTimestamp),await this.client.auth.requests.set(e,{authPayload:s.authPayload,requester:s.requester,expiryTimestamp:s.expiryTimestamp,id:e,pairingTopic:i,verifyContext:s.verifyContext,transportType:r})}),sign_client_dist_index_es_c(this,"setPendingSessionRequest",async e=>{const{id:t,topic:s,params:i,verifyContext:r}=e,o=i.request.expiryTimestamp||index_es_po(dist_index_es_N.wc_sessionRequest.req.ttl);this.client.core.expirer.set(t,o),await this.client.pendingRequest.set(t,{id:t,topic:s,params:i,verifyContext:r})}),sign_client_dist_index_es_c(this,"sendRequest",async e=>{const{topic:t,method:s,params:i,expiry:r,relayRpcId:o,clientRpcId:a,throwOnFailedPublish:l,appLink:p,tvf:h}=e,u=formatJsonRpcRequest(s,i,a);let d;const w=!!p;try{const _=w?ti:At;d=await this.client.core.crypto.encode(t,u,{encoding:_})}catch(_){throw await this.cleanup(),this.client.logger.error(`sendRequest() -> core.crypto.encode() for topic ${t} failed`),_}let m;if(dist_index_es_gt.includes(s)){const _=ci(JSON.stringify(u)),g=ci(d);m=await this.client.core.verify.register({id:g,decryptedId:_})}const f=dist_index_es_N[s].req;if(f.attestation=m,r&&(f.ttl=r),o&&(f.id=o),this.client.core.history.set(t,u),w){const _=xi(p,t,d);await global.Linking.openURL(_,this.client.name)}else{const _=dist_index_es_N[s].req;r&&(_.ttl=r),o&&(_.id=o),_.tvf=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},h),{correlationId:u.id}),l?(_.internal=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},_.internal),{throwOnFailedPublish:!0}),await this.client.core.relayer.publish(t,d,_)):this.client.core.relayer.publish(t,d,_).catch(g=>this.client.logger.error(g))}return u.id}),sign_client_dist_index_es_c(this,"sendResult",async e=>{const{id:t,topic:s,result:i,throwOnFailedPublish:r,encodeOpts:o,appLink:a}=e,l=formatJsonRpcResult(t,i);let p;const h=a&&typeof(global==null?void 0:global.Linking)<"u";try{const w=h?ti:At;p=await this.client.core.crypto.encode(s,l,sign_client_dist_index_es_b(sign_client_dist_index_es_v({},o||{}),{encoding:w}))}catch(w){throw await this.cleanup(),this.client.logger.error(`sendResult() -> core.crypto.encode() for topic ${s} failed`),w}let u,d;try{u=await this.client.core.history.get(s,t);const w=u.request;try{this.shouldSetTVF(w.method,w.params)&&(d=this.getTVFParams(t,w.params,i))}catch(m){this.client.logger.warn("sendResult() -> getTVFParams() failed",m)}}catch(w){throw this.client.logger.error(`sendResult() -> history.get(${s}, ${t}) failed`),w}if(h){const w=xi(a,s,p);await global.Linking.openURL(w,this.client.name)}else{const w=u.request.method,m=dist_index_es_N[w].res;m.tvf=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},d),{correlationId:t}),r?(m.internal=sign_client_dist_index_es_b(sign_client_dist_index_es_v({},m.internal),{throwOnFailedPublish:!0}),await this.client.core.relayer.publish(s,p,m)):this.client.core.relayer.publish(s,p,m).catch(f=>this.client.logger.error(f))}await this.client.core.history.resolve(l)}),sign_client_dist_index_es_c(this,"sendError",async e=>{const{id:t,topic:s,error:i,encodeOpts:r,rpcOpts:o,appLink:a}=e,l=formatJsonRpcError(t,i);let p;const h=a&&typeof(global==null?void 0:global.Linking)<"u";try{const d=h?ti:At;p=await this.client.core.crypto.encode(s,l,sign_client_dist_index_es_b(sign_client_dist_index_es_v({},r||{}),{encoding:d}))}catch(d){throw await this.cleanup(),this.client.logger.error(`sendError() -> core.crypto.encode() for topic ${s} failed`),d}let u;try{u=await this.client.core.history.get(s,t)}catch(d){throw this.client.logger.error(`sendError() -> history.get(${s}, ${t}) failed`),d}if(h){const d=xi(a,s,p);await global.Linking.openURL(d,this.client.name)}else{const d=u.request.method,w=o||dist_index_es_N[d].res;this.client.core.relayer.publish(s,p,w)}await this.client.core.history.resolve(l)}),sign_client_dist_index_es_c(this,"cleanup",async()=>{const e=[],t=[];this.client.session.getAll().forEach(s=>{let i=!1;index_es_go(s.expiry)&&(i=!0),this.client.core.crypto.keychain.has(s.topic)||(i=!0),i&&e.push(s.topic)}),this.client.proposal.getAll().forEach(s=>{index_es_go(s.expiryTimestamp)&&t.push(s.id)}),await Promise.all([...e.map(s=>this.deleteSession({topic:s})),...t.map(s=>this.deleteProposal(s))])}),sign_client_dist_index_es_c(this,"onProviderMessageEvent",async e=>{!this.initialized||this.relayMessageCache.length>0?this.relayMessageCache.push(e):await this.onRelayMessage(e)}),sign_client_dist_index_es_c(this,"onRelayEventRequest",async e=>{this.requestQueue.queue.push(e),await this.processRequestsQueue()}),sign_client_dist_index_es_c(this,"processRequestsQueue",async()=>{if(this.requestQueue.state===dist_index_es_$.active){this.client.logger.info("Request queue already active, skipping...");return}for(this.client.logger.info(`Request queue starting with ${this.requestQueue.queue.length} requests`);this.requestQueue.queue.length>0;){this.requestQueue.state=dist_index_es_$.active;const e=this.requestQueue.queue.shift();if(e)try{await this.processRequest(e)}catch(t){this.client.logger.warn(t)}}this.requestQueue.state=dist_index_es_$.idle}),sign_client_dist_index_es_c(this,"processRequest",async e=>{const{topic:t,payload:s,attestation:i,transportType:r,encryptedId:o}=e,a=s.method;if(!this.shouldIgnorePairingRequest({topic:t,requestMethod:a}))switch(a){case"wc_sessionPropose":return await this.onSessionProposeRequest({topic:t,payload:s,attestation:i,encryptedId:o});case"wc_sessionSettle":return await this.onSessionSettleRequest(t,s);case"wc_sessionUpdate":return await this.onSessionUpdateRequest(t,s);case"wc_sessionExtend":return await this.onSessionExtendRequest(t,s);case"wc_sessionPing":return await this.onSessionPingRequest(t,s);case"wc_sessionDelete":return await this.onSessionDeleteRequest(t,s);case"wc_sessionRequest":return await this.onSessionRequest({topic:t,payload:s,attestation:i,encryptedId:o,transportType:r});case"wc_sessionEvent":return await this.onSessionEventRequest(t,s);case"wc_sessionAuthenticate":return await this.onSessionAuthenticateRequest({topic:t,payload:s,attestation:i,encryptedId:o,transportType:r});default:return this.client.logger.info(`Unsupported request method ${a}`)}}),sign_client_dist_index_es_c(this,"onRelayEventResponse",async e=>{const{topic:t,payload:s,transportType:i}=e,r=(await this.client.core.history.get(t,s.id)).request.method;switch(r){case"wc_sessionPropose":return this.onSessionProposeResponse(t,s,i);case"wc_sessionSettle":return this.onSessionSettleResponse(t,s);case"wc_sessionUpdate":return this.onSessionUpdateResponse(t,s);case"wc_sessionExtend":return this.onSessionExtendResponse(t,s);case"wc_sessionPing":return this.onSessionPingResponse(t,s);case"wc_sessionRequest":return this.onSessionRequestResponse(t,s);case"wc_sessionAuthenticate":return this.onSessionAuthenticateResponse(t,s);default:return this.client.logger.info(`Unsupported response method ${r}`)}}),sign_client_dist_index_es_c(this,"onRelayEventUnknownPayload",e=>{const{topic:t}=e,{message:s}=dist_index_es_te("MISSING_OR_INVALID",`Decoded payload on topic ${t} is not identifiable as a JSON-RPC request or a response.`);throw new Error(s)}),sign_client_dist_index_es_c(this,"shouldIgnorePairingRequest",e=>{const{topic:t,requestMethod:s}=e,i=this.expectedPairingMethodMap.get(t);return!i||i.includes(s)?!1:!!(i.includes("wc_sessionAuthenticate")&&this.client.events.listenerCount("session_authenticate")>0)}),sign_client_dist_index_es_c(this,"onSessionProposeRequest",async e=>{const{topic:t,payload:s,attestation:i,encryptedId:r}=e,{params:o,id:a}=s;try{const l=this.client.core.eventClient.getEvent({topic:t});this.client.events.listenerCount("session_proposal")===0&&(console.warn("No listener for session_proposal event"),l?.setError(index_es_Y.proposal_listener_not_found)),this.isValidConnect(sign_client_dist_index_es_v({},s.params));const p=o.expiryTimestamp||index_es_po(dist_index_es_N.wc_sessionPropose.req.ttl),h=sign_client_dist_index_es_v({id:a,pairingTopic:t,expiryTimestamp:p},o);await this.setProposal(a,h);const u=await this.getVerifyContext({attestationId:i,hash:ci(JSON.stringify(s)),encryptedId:r,metadata:h.proposer.metadata});l?.addTrace(index_es_G.emit_session_proposal),this.client.events.emit("session_proposal",{id:a,params:h,verifyContext:u})}catch(l){await this.sendError({id:a,topic:t,error:l,rpcOpts:dist_index_es_N.wc_sessionPropose.autoReject}),this.client.logger.error(l)}}),sign_client_dist_index_es_c(this,"onSessionProposeResponse",async(e,t,s)=>{const{id:i}=t;if(isJsonRpcResult(t)){const{result:r}=t;this.client.logger.trace({type:"method",method:"onSessionProposeResponse",result:r});const o=this.client.proposal.get(i);this.client.logger.trace({type:"method",method:"onSessionProposeResponse",proposal:o});const a=o.proposer.publicKey;this.client.logger.trace({type:"method",method:"onSessionProposeResponse",selfPublicKey:a});const l=r.responderPublicKey;this.client.logger.trace({type:"method",method:"onSessionProposeResponse",peerPublicKey:l});const p=await this.client.core.crypto.generateSharedKey(a,l);this.pendingSessions.set(i,{sessionTopic:p,pairingTopic:e,proposalId:i,publicKey:a});const h=await this.client.core.relayer.subscribe(p,{transportType:s});this.client.logger.trace({type:"method",method:"onSessionProposeResponse",subscriptionId:h}),await this.client.core.pairing.activate({topic:e})}else if(isJsonRpcError(t)){await this.client.proposal.delete(i,index_es_de("USER_DISCONNECTED"));const r=index_es_yo("session_connect",i);if(this.events.listenerCount(r)===0)throw new Error(`emitting ${r} without any listeners, 954`);this.events.emit(r,{error:t.error})}}),sign_client_dist_index_es_c(this,"onSessionSettleRequest",async(e,t)=>{const{id:s,params:i}=t;try{this.isValidSessionSettleRequest(i);const{relay:r,controller:o,expiry:a,namespaces:l,sessionProperties:p,scopedProperties:h,sessionConfig:u}=t.params,d=[...this.pendingSessions.values()].find(f=>f.sessionTopic===e);if(!d)return this.client.logger.error(`Pending session not found for topic ${e}`);const w=this.client.proposal.get(d.proposalId),m=sign_client_dist_index_es_b(sign_client_dist_index_es_v(sign_client_dist_index_es_v(sign_client_dist_index_es_v({topic:e,relay:r,expiry:a,namespaces:l,acknowledged:!0,pairingTopic:d.pairingTopic,requiredNamespaces:w.requiredNamespaces,optionalNamespaces:w.optionalNamespaces,controller:o.publicKey,self:{publicKey:d.publicKey,metadata:this.client.metadata},peer:{publicKey:o.publicKey,metadata:o.metadata}},p&&{sessionProperties:p}),h&&{scopedProperties:h}),u&&{sessionConfig:u}),{transportType:dist_index_es_Q.relay});await this.client.session.set(m.topic,m),await this.setExpiry(m.topic,m.expiry),await this.client.core.pairing.updateMetadata({topic:d.pairingTopic,metadata:m.peer.metadata}),this.client.events.emit("session_connect",{session:m}),this.events.emit(index_es_yo("session_connect",d.proposalId),{session:m}),this.pendingSessions.delete(d.proposalId),this.deleteProposal(d.proposalId,!1),this.cleanupDuplicatePairings(m),await this.sendResult({id:t.id,topic:e,result:!0,throwOnFailedPublish:!0})}catch(r){await this.sendError({id:s,topic:e,error:r}),this.client.logger.error(r)}}),sign_client_dist_index_es_c(this,"onSessionSettleResponse",async(e,t)=>{const{id:s}=t;isJsonRpcResult(t)?(await this.client.session.update(e,{acknowledged:!0}),this.events.emit(index_es_yo("session_approve",s),{})):isJsonRpcError(t)&&(await this.client.session.delete(e,index_es_de("USER_DISCONNECTED")),this.events.emit(index_es_yo("session_approve",s),{error:t.error}))}),sign_client_dist_index_es_c(this,"onSessionUpdateRequest",async(e,t)=>{const{params:s,id:i}=t;try{const r=`${e}_session_update`,o=ec.get(r);if(o&&this.isRequestOutOfSync(o,i)){this.client.logger.warn(`Discarding out of sync request - ${i}`),this.sendError({id:i,topic:e,error:index_es_de("INVALID_UPDATE_REQUEST")});return}this.isValidUpdate(sign_client_dist_index_es_v({topic:e},s));try{ec.set(r,i),await this.client.session.update(e,{namespaces:s.namespaces}),await this.sendResult({id:i,topic:e,result:!0,throwOnFailedPublish:!0})}catch(a){throw ec.delete(r),a}this.client.events.emit("session_update",{id:i,topic:e,params:s})}catch(r){await this.sendError({id:i,topic:e,error:r}),this.client.logger.error(r)}}),sign_client_dist_index_es_c(this,"isRequestOutOfSync",(e,t)=>t.toString().slice(0,-3)<e.toString().slice(0,-3)),sign_client_dist_index_es_c(this,"onSessionUpdateResponse",(e,t)=>{const{id:s}=t,i=index_es_yo("session_update",s);if(this.events.listenerCount(i)===0)throw new Error(`emitting ${i} without any listeners`);isJsonRpcResult(t)?this.events.emit(index_es_yo("session_update",s),{}):isJsonRpcError(t)&&this.events.emit(index_es_yo("session_update",s),{error:t.error})}),sign_client_dist_index_es_c(this,"onSessionExtendRequest",async(e,t)=>{const{id:s}=t;try{this.isValidExtend({topic:e}),await this.setExpiry(e,index_es_po(sign_client_dist_index_es_J)),await this.sendResult({id:s,topic:e,result:!0,throwOnFailedPublish:!0}),this.client.events.emit("session_extend",{id:s,topic:e})}catch(i){await this.sendError({id:s,topic:e,error:i}),this.client.logger.error(i)}}),sign_client_dist_index_es_c(this,"onSessionExtendResponse",(e,t)=>{const{id:s}=t,i=index_es_yo("session_extend",s);if(this.events.listenerCount(i)===0)throw new Error(`emitting ${i} without any listeners`);isJsonRpcResult(t)?this.events.emit(index_es_yo("session_extend",s),{}):isJsonRpcError(t)&&this.events.emit(index_es_yo("session_extend",s),{error:t.error})}),sign_client_dist_index_es_c(this,"onSessionPingRequest",async(e,t)=>{const{id:s}=t;try{this.isValidPing({topic:e}),await this.sendResult({id:s,topic:e,result:!0,throwOnFailedPublish:!0}),this.client.events.emit("session_ping",{id:s,topic:e})}catch(i){await this.sendError({id:s,topic:e,error:i}),this.client.logger.error(i)}}),sign_client_dist_index_es_c(this,"onSessionPingResponse",(e,t)=>{const{id:s}=t,i=index_es_yo("session_ping",s);setTimeout(()=>{if(this.events.listenerCount(i)===0)throw new Error(`emitting ${i} without any listeners 2176`);isJsonRpcResult(t)?this.events.emit(index_es_yo("session_ping",s),{}):isJsonRpcError(t)&&this.events.emit(index_es_yo("session_ping",s),{error:t.error})},500)}),sign_client_dist_index_es_c(this,"onSessionDeleteRequest",async(e,t)=>{const{id:s}=t;try{this.isValidDisconnect({topic:e,reason:t.params}),Promise.all([new Promise(i=>{this.client.core.relayer.once(core_dist_index_es_C.publish,async()=>{i(await this.deleteSession({topic:e,id:s}))})}),this.sendResult({id:s,topic:e,result:!0,throwOnFailedPublish:!0}),this.cleanupPendingSentRequestsForTopic({topic:e,error:index_es_de("USER_DISCONNECTED")})]).catch(i=>this.client.logger.error(i))}catch(i){this.client.logger.error(i)}}),sign_client_dist_index_es_c(this,"onSessionRequest",async e=>{var t,s,i;const{topic:r,payload:o,attestation:a,encryptedId:l,transportType:p}=e,{id:h,params:u}=o;try{await this.isValidRequest(sign_client_dist_index_es_v({topic:r},u));const d=this.client.session.get(r),w=await this.getVerifyContext({attestationId:a,hash:ci(JSON.stringify(formatJsonRpcRequest("wc_sessionRequest",u,h))),encryptedId:l,metadata:d.peer.metadata,transportType:p}),m={id:h,topic:r,params:u,verifyContext:w};await this.setPendingSessionRequest(m),p===dist_index_es_Q.link_mode&&(t=d.peer.metadata.redirect)!=null&&t.universal&&this.client.core.addLinkModeSupportedApp((s=d.peer.metadata.redirect)==null?void 0:s.universal),(i=this.client.signConfig)!=null&&i.disableRequestQueue?this.emitSessionRequest(m):(this.addSessionRequestToSessionRequestQueue(m),this.processSessionRequestQueue())}catch(d){await this.sendError({id:h,topic:r,error:d}),this.client.logger.error(d)}}),sign_client_dist_index_es_c(this,"onSessionRequestResponse",(e,t)=>{const{id:s}=t,i=index_es_yo("session_request",s);if(this.events.listenerCount(i)===0)throw new Error(`emitting ${i} without any listeners`);isJsonRpcResult(t)?this.events.emit(index_es_yo("session_request",s),{result:t.result}):isJsonRpcError(t)&&this.events.emit(index_es_yo("session_request",s),{error:t.error})}),sign_client_dist_index_es_c(this,"onSessionEventRequest",async(e,t)=>{const{id:s,params:i}=t;try{const r=`${e}_session_event_${i.event.name}`,o=ec.get(r);if(o&&this.isRequestOutOfSync(o,s)){this.client.logger.info(`Discarding out of sync request - ${s}`);return}this.isValidEmit(sign_client_dist_index_es_v({topic:e},i)),this.client.events.emit("session_event",{id:s,topic:e,params:i}),ec.set(r,s)}catch(r){await this.sendError({id:s,topic:e,error:r}),this.client.logger.error(r)}}),sign_client_dist_index_es_c(this,"onSessionAuthenticateResponse",(e,t)=>{const{id:s}=t;this.client.logger.trace({type:"method",method:"onSessionAuthenticateResponse",topic:e,payload:t}),isJsonRpcResult(t)?this.events.emit(index_es_yo("session_request",s),{result:t.result}):isJsonRpcError(t)&&this.events.emit(index_es_yo("session_request",s),{error:t.error})}),sign_client_dist_index_es_c(this,"onSessionAuthenticateRequest",async e=>{var t;const{topic:s,payload:i,attestation:r,encryptedId:o,transportType:a}=e;try{const{requester:l,authPayload:p,expiryTimestamp:h}=i.params,u=await this.getVerifyContext({attestationId:r,hash:ci(JSON.stringify(i)),encryptedId:o,metadata:l.metadata,transportType:a}),d={requester:l,pairingTopic:s,id:i.id,authPayload:p,verifyContext:u,expiryTimestamp:h};await this.setAuthRequest(i.id,{request:d,pairingTopic:s,transportType:a}),a===dist_index_es_Q.link_mode&&(t=l.metadata.redirect)!=null&&t.universal&&this.client.core.addLinkModeSupportedApp(l.metadata.redirect.universal),this.client.events.emit("session_authenticate",{topic:s,params:i.params,id:i.id,verifyContext:u})}catch(l){this.client.logger.error(l);const p=i.params.requester.publicKey,h=await this.client.core.crypto.generateKeyPair(),u=this.getAppLinkIfEnabled(i.params.requester.metadata,a),d={type:index_es_Oe,receiverPublicKey:p,senderPublicKey:h};await this.sendError({id:i.id,topic:s,error:l,encodeOpts:d,rpcOpts:dist_index_es_N.wc_sessionAuthenticate.autoReject,appLink:u})}}),sign_client_dist_index_es_c(this,"addSessionRequestToSessionRequestQueue",e=>{this.sessionRequestQueue.queue.push(e)}),sign_client_dist_index_es_c(this,"cleanupAfterResponse",e=>{this.deletePendingSessionRequest(e.response.id,{message:"fulfilled",code:0}),setTimeout(()=>{this.sessionRequestQueue.state=dist_index_es_$.idle,this.processSessionRequestQueue()},(0,cjs.toMiliseconds)(this.requestQueueDelay))}),sign_client_dist_index_es_c(this,"cleanupPendingSentRequestsForTopic",({topic:e,error:t})=>{const s=this.client.core.history.pending;s.length>0&&s.filter(i=>i.topic===e&&i.request.method==="wc_sessionRequest").forEach(i=>{const r=i.request.id,o=index_es_yo("session_request",r);if(this.events.listenerCount(o)===0)throw new Error(`emitting ${o} without any listeners`);this.events.emit(index_es_yo("session_request",i.request.id),{error:t})})}),sign_client_dist_index_es_c(this,"processSessionRequestQueue",()=>{if(this.sessionRequestQueue.state===dist_index_es_$.active){this.client.logger.info("session request queue is already active.");return}const e=this.sessionRequestQueue.queue[0];if(!e){this.client.logger.info("session request queue is empty.");return}try{this.sessionRequestQueue.state=dist_index_es_$.active,this.emitSessionRequest(e)}catch(t){this.client.logger.error(t)}}),sign_client_dist_index_es_c(this,"emitSessionRequest",e=>{this.client.events.emit("session_request",e)}),sign_client_dist_index_es_c(this,"onPairingCreated",e=>{if(e.methods&&this.expectedPairingMethodMap.set(e.topic,e.methods),e.active)return;const t=this.client.proposal.getAll().find(s=>s.pairingTopic===e.topic);t&&this.onSessionProposeRequest({topic:e.topic,payload:formatJsonRpcRequest("wc_sessionPropose",sign_client_dist_index_es_b(sign_client_dist_index_es_v({},t),{requiredNamespaces:t.requiredNamespaces,optionalNamespaces:t.optionalNamespaces,relays:t.relays,proposer:t.proposer,sessionProperties:t.sessionProperties,scopedProperties:t.scopedProperties}),t.id)})}),sign_client_dist_index_es_c(this,"isValidConnect",async e=>{if(!Vi(e)){const{message:l}=dist_index_es_te("MISSING_OR_INVALID",`connect() params: ${JSON.stringify(e)}`);throw new Error(l)}const{pairingTopic:t,requiredNamespaces:s,optionalNamespaces:i,sessionProperties:r,scopedProperties:o,relays:a}=e;if(ae(t)||await this.isValidPairingTopic(t),!Di(a,!0)){const{message:l}=dist_index_es_te("MISSING_OR_INVALID",`connect() relays: ${a}`);throw new Error(l)}if(!ae(s)&&index_es_qe(s)!==0&&this.validateNamespaces(s,"requiredNamespaces"),!ae(i)&&index_es_qe(i)!==0&&this.validateNamespaces(i,"optionalNamespaces"),ae(r)||this.validateSessionProps(r,"sessionProperties"),!ae(o)){this.validateSessionProps(o,"scopedProperties");const l=Object.keys(s||{}).concat(Object.keys(i||{}));if(!Object.keys(o).every(p=>l.includes(p)))throw new Error(`Scoped properties must be a subset of required/optional namespaces, received: ${JSON.stringify(o)}, required/optional namespaces: ${JSON.stringify(l)}`)}}),sign_client_dist_index_es_c(this,"validateNamespaces",(e,t)=>{const s=ki(e,"connect()",t);if(s)throw new Error(s.message)}),sign_client_dist_index_es_c(this,"isValidApprove",async e=>{if(!Vi(e))throw new Error(dist_index_es_te("MISSING_OR_INVALID",`approve() params: ${e}`).message);const{id:t,namespaces:s,relayProtocol:i,sessionProperties:r,scopedProperties:o}=e;this.checkRecentlyDeleted(t),await this.isValidProposalId(t);const a=this.client.proposal.get(t),l=index_es_Or(s,"approve()");if(l)throw new Error(l.message);const p=index_es_Nr(a.requiredNamespaces,s,"approve()");if(p)throw new Error(p.message);if(!index_es_q(i,!0)){const{message:h}=dist_index_es_te("MISSING_OR_INVALID",`approve() relayProtocol: ${i}`);throw new Error(h)}if(ae(r)||this.validateSessionProps(r,"sessionProperties"),!ae(o)){this.validateSessionProps(o,"scopedProperties");const h=new Set(Object.keys(s));if(!Object.keys(o).every(u=>h.has(u)))throw new Error(`Scoped properties must be a subset of approved namespaces, received: ${JSON.stringify(o)}, approved namespaces: ${Array.from(h).join(", ")}`)}}),sign_client_dist_index_es_c(this,"isValidReject",async e=>{if(!Vi(e)){const{message:i}=dist_index_es_te("MISSING_OR_INVALID",`reject() params: ${e}`);throw new Error(i)}const{id:t,reason:s}=e;if(this.checkRecentlyDeleted(t),await this.isValidProposalId(t),!Hi(s)){const{message:i}=dist_index_es_te("MISSING_OR_INVALID",`reject() reason: ${JSON.stringify(s)}`);throw new Error(i)}}),sign_client_dist_index_es_c(this,"isValidSessionSettleRequest",e=>{if(!Vi(e)){const{message:l}=dist_index_es_te("MISSING_OR_INVALID",`onSessionSettleRequest() params: ${e}`);throw new Error(l)}const{relay:t,controller:s,namespaces:i,expiry:r}=e;if(!index_es_Ar(t)){const{message:l}=dist_index_es_te("MISSING_OR_INVALID","onSessionSettleRequest() relay protocol should be a string");throw new Error(l)}const o=Ci(s,"onSessionSettleRequest()");if(o)throw new Error(o.message);const a=index_es_Or(i,"onSessionSettleRequest()");if(a)throw new Error(a.message);if(index_es_go(r)){const{message:l}=dist_index_es_te("EXPIRED","onSessionSettleRequest()");throw new Error(l)}}),sign_client_dist_index_es_c(this,"isValidUpdate",async e=>{if(!Vi(e)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`update() params: ${e}`);throw new Error(a)}const{topic:t,namespaces:s}=e;this.checkRecentlyDeleted(t),await this.isValidSessionTopic(t);const i=this.client.session.get(t),r=index_es_Or(s,"update()");if(r)throw new Error(r.message);const o=index_es_Nr(i.requiredNamespaces,s,"update()");if(o)throw new Error(o.message)}),sign_client_dist_index_es_c(this,"isValidExtend",async e=>{if(!Vi(e)){const{message:s}=dist_index_es_te("MISSING_OR_INVALID",`extend() params: ${e}`);throw new Error(s)}const{topic:t}=e;this.checkRecentlyDeleted(t),await this.isValidSessionTopic(t)}),sign_client_dist_index_es_c(this,"isValidRequest",async e=>{if(!Vi(e)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`request() params: ${e}`);throw new Error(a)}const{topic:t,request:s,chainId:i,expiry:r}=e;this.checkRecentlyDeleted(t),await this.isValidSessionTopic(t);const{namespaces:o}=this.client.session.get(t);if(!Gi(o,i)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`request() chainId: ${i}`);throw new Error(a)}if(!Ki(s)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`request() ${JSON.stringify(s)}`);throw new Error(a)}if(!Wi(o,i,s.method)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`request() method: ${s.method}`);throw new Error(a)}if(r&&!Xi(r,sign_client_dist_index_es_e)){const{message:a}=dist_index_es_te("MISSING_OR_INVALID",`request() expiry: ${r}. Expiry must be a number (in seconds) between ${sign_client_dist_index_es_e.min} and ${sign_client_dist_index_es_e.max}`);throw new Error(a)}}),sign_client_dist_index_es_c(this,"isValidRespond",async e=>{var t;if(!Vi(e)){const{message:r}=dist_index_es_te("MISSING_OR_INVALID",`respond() params: ${e}`);throw new Error(r)}const{topic:s,response:i}=e;try{await this.isValidSessionTopic(s)}catch(r){throw(t=e?.response)!=null&&t.id&&this.cleanupAfterResponse(e),r}if(!Fi(i)){const{message:r}=dist_index_es_te("MISSING_OR_INVALID",`respond() response: ${JSON.stringify(i)}`);throw new Error(r)}}),sign_client_dist_index_es_c(this,"isValidPing",async e=>{if(!Vi(e)){const{message:s}=dist_index_es_te("MISSING_OR_INVALID",`ping() params: ${e}`);throw new Error(s)}const{topic:t}=e;await this.isValidSessionOrPairingTopic(t)}),sign_client_dist_index_es_c(this,"isValidEmit",async e=>{if(!Vi(e)){const{message:o}=dist_index_es_te("MISSING_OR_INVALID",`emit() params: ${e}`);throw new Error(o)}const{topic:t,event:s,chainId:i}=e;await this.isValidSessionTopic(t);const{namespaces:r}=this.client.session.get(t);if(!Gi(r,i)){const{message:o}=dist_index_es_te("MISSING_OR_INVALID",`emit() chainId: ${i}`);throw new Error(o)}if(!qi(s)){const{message:o}=dist_index_es_te("MISSING_OR_INVALID",`emit() event: ${JSON.stringify(s)}`);throw new Error(o)}if(!zi(r,i,s.name)){const{message:o}=dist_index_es_te("MISSING_OR_INVALID",`emit() event: ${JSON.stringify(s)}`);throw new Error(o)}}),sign_client_dist_index_es_c(this,"isValidDisconnect",async e=>{if(!Vi(e)){const{message:s}=dist_index_es_te("MISSING_OR_INVALID",`disconnect() params: ${e}`);throw new Error(s)}const{topic:t}=e;await this.isValidSessionOrPairingTopic(t)}),sign_client_dist_index_es_c(this,"isValidAuthenticate",e=>{const{chains:t,uri:s,domain:i,nonce:r}=e;if(!Array.isArray(t)||t.length===0)throw new Error("chains is required and must be a non-empty array");if(!index_es_q(s,!1))throw new Error("uri is required parameter");if(!index_es_q(i,!1))throw new Error("domain is required parameter");if(!index_es_q(r,!1))throw new Error("nonce is required parameter");if([...new Set(t.map(a=>index_es_Ye(a).namespace))].length>1)throw new Error("Multi-namespace requests are not supported. Please request single namespace only.");const{namespace:o}=index_es_Ye(t[0]);if(o!=="eip155")throw new Error("Only eip155 namespace is supported for authenticated sessions. Please use .connect() for non-eip155 chains.")}),sign_client_dist_index_es_c(this,"getVerifyContext",async e=>{const{attestationId:t,hash:s,encryptedId:i,metadata:r,transportType:o}=e,a={verified:{verifyUrl:r.verifyUrl||index_es_ue,validation:"UNKNOWN",origin:r.url||""}};try{if(o===dist_index_es_Q.link_mode){const p=this.getAppLinkIfEnabled(r,o);return a.verified.validation=p&&new URL(p).origin===new URL(r.url).origin?"VALID":"INVALID",a}const l=await this.client.core.verify.resolve({attestationId:t,hash:s,encryptedId:i,verifyUrl:r.verifyUrl});l&&(a.verified.origin=l.origin,a.verified.isScam=l.isScam,a.verified.validation=l.origin===new URL(r.url).origin?"VALID":"INVALID")}catch(l){this.client.logger.warn(l)}return this.client.logger.debug(`Verify context: ${JSON.stringify(a)}`),a}),sign_client_dist_index_es_c(this,"validateSessionProps",(e,t)=>{Object.values(e).forEach((s,i)=>{if(s==null){const{message:r}=dist_index_es_te("MISSING_OR_INVALID",`${t} must contain an existing value for each key. Received: ${s} for key ${Object.keys(e)[i]}`);throw new Error(r)}})}),sign_client_dist_index_es_c(this,"getPendingAuthRequest",e=>{const t=this.client.auth.requests.get(e);return typeof t=="object"?t:void 0}),sign_client_dist_index_es_c(this,"addToRecentlyDeleted",(e,t)=>{if(this.recentlyDeletedMap.set(e,t),this.recentlyDeletedMap.size>=this.recentlyDeletedLimit){let s=0;const i=this.recentlyDeletedLimit/2;for(const r of this.recentlyDeletedMap.keys()){if(s++>=i)break;this.recentlyDeletedMap.delete(r)}}}),sign_client_dist_index_es_c(this,"checkRecentlyDeleted",e=>{const t=this.recentlyDeletedMap.get(e);if(t){const{message:s}=dist_index_es_te("MISSING_OR_INVALID",`Record was recently deleted - ${t}: ${e}`);throw new Error(s)}}),sign_client_dist_index_es_c(this,"isLinkModeEnabled",(e,t)=>{var s,i,r,o,a,l,p,h,u;return!e||t!==dist_index_es_Q.link_mode?!1:((i=(s=this.client.metadata)==null?void 0:s.redirect)==null?void 0:i.linkMode)===!0&&((o=(r=this.client.metadata)==null?void 0:r.redirect)==null?void 0:o.universal)!==void 0&&((l=(a=this.client.metadata)==null?void 0:a.redirect)==null?void 0:l.universal)!==""&&((p=e?.redirect)==null?void 0:p.universal)!==void 0&&((h=e?.redirect)==null?void 0:h.universal)!==""&&((u=e?.redirect)==null?void 0:u.linkMode)===!0&&this.client.core.linkModeSupportedApps.includes(e.redirect.universal)&&typeof(global==null?void 0:global.Linking)<"u"}),sign_client_dist_index_es_c(this,"getAppLinkIfEnabled",(e,t)=>{var s;return this.isLinkModeEnabled(e,t)?(s=e?.redirect)==null?void 0:s.universal:void 0}),sign_client_dist_index_es_c(this,"handleLinkModeMessage",({url:e})=>{if(!e||!e.includes("wc_ev")||!e.includes("topic"))return;const t=index_es_wo(e,"topic")||"",s=decodeURIComponent(index_es_wo(e,"wc_ev")||""),i=this.client.session.keys.includes(t);i&&this.client.session.update(t,{transportType:dist_index_es_Q.link_mode}),this.client.core.dispatchEnvelope({topic:t,message:s,sessionExists:i})}),sign_client_dist_index_es_c(this,"registerLinkModeListeners",async()=>{var e;if(index_es_vo()||ne()&&(e=this.client.metadata.redirect)!=null&&e.linkMode){const t=global==null?void 0:global.Linking;if(typeof t<"u"){t.addEventListener("url",this.handleLinkModeMessage,this.client.name);const s=await t.getInitialURL();s&&setTimeout(()=>{this.handleLinkModeMessage({url:s})},50)}}}),sign_client_dist_index_es_c(this,"shouldSetTVF",(e,t)=>{if(!t||e!=="wc_sessionRequest")return!1;const{request:s}=t;return Object.keys(sign_client_dist_index_es_Ue).includes(s.method)}),sign_client_dist_index_es_c(this,"getTVFParams",(e,t,s)=>{var i,r;try{const o=t.request.method,a=this.extractTxHashesFromResult(o,s);return sign_client_dist_index_es_b(sign_client_dist_index_es_v({correlationId:e,rpcMethods:[o],chainId:t.chainId},this.isValidContractData(t.request.params)&&{contractAddresses:[(r=(i=t.request.params)==null?void 0:i[0])==null?void 0:r.to]}),{txHashes:a})}catch(o){this.client.logger.warn("Error getting TVF params",o)}return{}}),sign_client_dist_index_es_c(this,"isValidContractData",e=>{var t;if(!e)return!1;try{const s=e?.data||((t=e?.[0])==null?void 0:t.data);if(!s.startsWith("0x"))return!1;const i=s.slice(2);return/^[0-9a-fA-F]*$/.test(i)?i.length%2===0:!1}catch{}return!1}),sign_client_dist_index_es_c(this,"extractTxHashesFromResult",(e,t)=>{try{const s=sign_client_dist_index_es_Ue[e];if(typeof t=="string")return[t];const i=t[s.key];if(index_es_$e(i))return e==="solana_signAllTransactions"?i.map(r=>index_es_qo(r)):i;if(typeof i=="string")return[i]}catch(s){this.client.logger.warn("Error extracting tx hashes from result",s)}return[]})}async processPendingMessageEvents(){try{const n=this.client.session.keys,e=this.client.core.relayer.messages.getWithoutAck(n);for(const[t,s]of Object.entries(e))for(const i of s)try{await this.onProviderMessageEvent({topic:t,message:i,publishedAt:Date.now()})}catch{this.client.logger.warn(`Error processing pending message event for topic: ${t}, message: ${i}`)}}catch(n){this.client.logger.warn("processPendingMessageEvents failed",n)}}isInitialized(){if(!this.initialized){const{message:n}=dist_index_es_te("NOT_INITIALIZED",this.name);throw new Error(n)}}async confirmOnlineStateOrThrow(){await this.client.core.relayer.confirmOnlineStateOrThrow()}registerRelayerEvents(){this.client.core.relayer.on(core_dist_index_es_C.message,n=>{this.onProviderMessageEvent(n)})}async onRelayMessage(n){const{topic:e,message:t,attestation:s,transportType:i}=n,{publicKey:r}=this.client.auth.authKeys.keys.includes(index_es_ce)?this.client.auth.authKeys.get(index_es_ce):{responseTopic:void 0,publicKey:void 0};try{const o=await this.client.core.crypto.decode(e,t,{receiverPublicKey:r,encoding:i===dist_index_es_Q.link_mode?ti:At});isJsonRpcRequest(o)?(this.client.core.history.set(e,o),await this.onRelayEventRequest({topic:e,payload:o,attestation:s,transportType:i,encryptedId:ci(t)})):isJsonRpcResponse(o)?(await this.client.core.history.resolve(o),await this.onRelayEventResponse({topic:e,payload:o,transportType:i}),this.client.core.history.delete(e,o.id)):await this.onRelayEventUnknownPayload({topic:e,payload:o,transportType:i}),await this.client.core.relayer.messages.ack(e,t)}catch(o){this.client.logger.error(o)}}registerExpirerEvents(){this.client.core.expirer.on(index_es_F.expired,async n=>{const{topic:e,id:t}=index_es_ho(n.target);if(t&&this.client.pendingRequest.keys.includes(t))return await this.deletePendingSessionRequest(t,dist_index_es_te("EXPIRED"),!0);if(t&&this.client.auth.requests.keys.includes(t))return await this.deletePendingAuthRequest(t,dist_index_es_te("EXPIRED"),!0);e?this.client.session.keys.includes(e)&&(await this.deleteSession({topic:e,expirerHasDeleted:!0}),this.client.events.emit("session_expire",{topic:e})):t&&(await this.deleteProposal(t,!0),this.client.events.emit("proposal_expire",{id:t}))})}registerPairingEvents(){this.client.core.pairing.events.on(index_es_se.create,n=>this.onPairingCreated(n)),this.client.core.pairing.events.on(index_es_se.delete,n=>{this.addToRecentlyDeleted(n.topic,"pairing")})}isValidPairingTopic(n){if(!index_es_q(n,!1)){const{message:e}=dist_index_es_te("MISSING_OR_INVALID",`pairing topic should be a string: ${n}`);throw new Error(e)}if(!this.client.core.pairing.pairings.keys.includes(n)){const{message:e}=dist_index_es_te("NO_MATCHING_KEY",`pairing topic doesn't exist: ${n}`);throw new Error(e)}if(index_es_go(this.client.core.pairing.pairings.get(n).expiry)){const{message:e}=dist_index_es_te("EXPIRED",`pairing topic: ${n}`);throw new Error(e)}}async isValidSessionTopic(n){if(!index_es_q(n,!1)){const{message:e}=dist_index_es_te("MISSING_OR_INVALID",`session topic should be a string: ${n}`);throw new Error(e)}if(this.checkRecentlyDeleted(n),!this.client.session.keys.includes(n)){const{message:e}=dist_index_es_te("NO_MATCHING_KEY",`session topic doesn't exist: ${n}`);throw new Error(e)}if(index_es_go(this.client.session.get(n).expiry)){await this.deleteSession({topic:n});const{message:e}=dist_index_es_te("EXPIRED",`session topic: ${n}`);throw new Error(e)}if(!this.client.core.crypto.keychain.has(n)){const{message:e}=dist_index_es_te("MISSING_OR_INVALID",`session topic does not exist in keychain: ${n}`);throw await this.deleteSession({topic:n}),new Error(e)}}async isValidSessionOrPairingTopic(n){if(this.checkRecentlyDeleted(n),this.client.session.keys.includes(n))await this.isValidSessionTopic(n);else if(this.client.core.pairing.pairings.keys.includes(n))this.isValidPairingTopic(n);else if(index_es_q(n,!1)){const{message:e}=dist_index_es_te("NO_MATCHING_KEY",`session or pairing topic doesn't exist: ${n}`);throw new Error(e)}else{const{message:e}=dist_index_es_te("MISSING_OR_INVALID",`session or pairing topic should be a string: ${n}`);throw new Error(e)}}async isValidProposalId(n){if(!Mi(n)){const{message:e}=dist_index_es_te("MISSING_OR_INVALID",`proposal id should be a number: ${n}`);throw new Error(e)}if(!this.client.proposal.keys.includes(n)){const{message:e}=dist_index_es_te("NO_MATCHING_KEY",`proposal id doesn't exist: ${n}`);throw new Error(e)}if(index_es_go(this.client.proposal.get(n).expiryTimestamp)){await this.deleteProposal(n);const{message:e}=dist_index_es_te("EXPIRED",`proposal id: ${n}`);throw new Error(e)}}}class index_es_Ns extends index_es_zi{constructor(n,e){super(n,e,index_es_pt,dist_index_es_we),this.core=n,this.logger=e}}class sign_client_dist_index_es_St extends index_es_zi{constructor(n,e){super(n,e,dist_index_es_ht,dist_index_es_we),this.core=n,this.logger=e}}class index_es_Os extends index_es_zi{constructor(n,e){super(n,e,dist_index_es_ut,dist_index_es_we,t=>t.id),this.core=n,this.logger=e}}class index_es_bs extends index_es_zi{constructor(n,e){super(n,e,index_es_mt,index_es_ae,()=>index_es_ce),this.core=n,this.logger=e}}class index_es_As extends index_es_zi{constructor(n,e){super(n,e,dist_index_es_t,index_es_ae),this.core=n,this.logger=e}}class index_es_xs extends index_es_zi{constructor(n,e){super(n,e,sign_client_dist_index_es_Et,index_es_ae,t=>t.id),this.core=n,this.logger=e}}var index_es_Cs=Object.defineProperty,index_es_Vs=(S,n,e)=>n in S?index_es_Cs(S,n,{enumerable:!0,configurable:!0,writable:!0,value:e}):S[n]=e,sign_client_dist_index_es_Ge=(S,n,e)=>index_es_Vs(S,typeof n!="symbol"?n+"":n,e);class index_es_Ds{constructor(n,e){this.core=n,this.logger=e,sign_client_dist_index_es_Ge(this,"authKeys"),sign_client_dist_index_es_Ge(this,"pairingTopics"),sign_client_dist_index_es_Ge(this,"requests"),this.authKeys=new index_es_bs(this.core,this.logger),this.pairingTopics=new index_es_As(this.core,this.logger),this.requests=new index_es_xs(this.core,this.logger)}async init(){await this.authKeys.init(),await this.pairingTopics.init(),await this.requests.init()}}var index_es_Ls=Object.defineProperty,index_es_ks=(S,n,e)=>n in S?index_es_Ls(S,n,{enumerable:!0,configurable:!0,writable:!0,value:e}):S[n]=e,sign_client_dist_index_es_E=(S,n,e)=>index_es_ks(S,typeof n!="symbol"?n+"":n,e);class sign_client_dist_index_es_Ee extends dist_index_es_J{constructor(n){super(n),sign_client_dist_index_es_E(this,"protocol",dist_index_es_De),sign_client_dist_index_es_E(this,"version",sign_client_dist_index_es_Le),sign_client_dist_index_es_E(this,"name",dist_index_es_me.name),sign_client_dist_index_es_E(this,"metadata"),sign_client_dist_index_es_E(this,"core"),sign_client_dist_index_es_E(this,"logger"),sign_client_dist_index_es_E(this,"events",new external_events_.EventEmitter),sign_client_dist_index_es_E(this,"engine"),sign_client_dist_index_es_E(this,"session"),sign_client_dist_index_es_E(this,"proposal"),sign_client_dist_index_es_E(this,"pendingRequest"),sign_client_dist_index_es_E(this,"auth"),sign_client_dist_index_es_E(this,"signConfig"),sign_client_dist_index_es_E(this,"on",(t,s)=>this.events.on(t,s)),sign_client_dist_index_es_E(this,"once",(t,s)=>this.events.once(t,s)),sign_client_dist_index_es_E(this,"off",(t,s)=>this.events.off(t,s)),sign_client_dist_index_es_E(this,"removeListener",(t,s)=>this.events.removeListener(t,s)),sign_client_dist_index_es_E(this,"removeAllListeners",t=>this.events.removeAllListeners(t)),sign_client_dist_index_es_E(this,"connect",async t=>{try{return await this.engine.connect(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"pair",async t=>{try{return await this.engine.pair(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"approve",async t=>{try{return await this.engine.approve(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"reject",async t=>{try{return await this.engine.reject(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"update",async t=>{try{return await this.engine.update(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"extend",async t=>{try{return await this.engine.extend(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"request",async t=>{try{return await this.engine.request(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"respond",async t=>{try{return await this.engine.respond(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"ping",async t=>{try{return await this.engine.ping(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"emit",async t=>{try{return await this.engine.emit(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"disconnect",async t=>{try{return await this.engine.disconnect(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"find",t=>{try{return this.engine.find(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"getPendingSessionRequests",()=>{try{return this.engine.getPendingSessionRequests()}catch(t){throw this.logger.error(t.message),t}}),sign_client_dist_index_es_E(this,"authenticate",async(t,s)=>{try{return await this.engine.authenticate(t,s)}catch(i){throw this.logger.error(i.message),i}}),sign_client_dist_index_es_E(this,"formatAuthMessage",t=>{try{return this.engine.formatAuthMessage(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"approveSessionAuthenticate",async t=>{try{return await this.engine.approveSessionAuthenticate(t)}catch(s){throw this.logger.error(s.message),s}}),sign_client_dist_index_es_E(this,"rejectSessionAuthenticate",async t=>{try{return await this.engine.rejectSessionAuthenticate(t)}catch(s){throw this.logger.error(s.message),s}}),this.name=n?.name||dist_index_es_me.name,this.metadata=n?.metadata||index_es_Xr(),this.signConfig=n?.signConfig;const e=typeof n?.logger<"u"&&typeof n?.logger!="string"?n.logger:pino_default()(logger_dist_index_es_k({level:n?.logger||dist_index_es_me.logger}));this.core=n?.core||new dist_index_es_Jo(n),this.logger=dist_index_es_E(e,this.name),this.session=new sign_client_dist_index_es_St(this.core,this.logger),this.proposal=new index_es_Ns(this.core,this.logger),this.pendingRequest=new index_es_Os(this.core,this.logger),this.engine=new index_es_Ps(this),this.auth=new index_es_Ds(this.core,this.logger)}static async init(n){const e=new sign_client_dist_index_es_Ee(n);return await e.initialize(),e}get context(){return index_es_y(this.logger)}get pairing(){return this.core.pairing.pairings}async initialize(){this.logger.trace("Initialized");try{await this.core.start(),await this.session.init(),await this.proposal.init(),await this.pendingRequest.init(),await this.auth.init(),await this.engine.init(),this.logger.info("SignClient Initialization Success"),setTimeout(()=>{this.engine.processRelayMessageCache()},(0,cjs.toMiliseconds)(cjs.ONE_SECOND))}catch(n){throw this.logger.info("SignClient Initialization Failure"),this.logger.error(n.message),n}}}const index_es_Ms=(/* unused pure expression or super */ null && (sign_client_dist_index_es_St)),index_es_$s=(/* unused pure expression or super */ null && (sign_client_dist_index_es_Ee));
//# sourceMappingURL=index.es.js.map

// EXTERNAL MODULE: ./node_modules/cross-fetch/dist/node-ponyfill.js
var node_ponyfill = __webpack_require__(15221);
var node_ponyfill_default = /*#__PURE__*/__webpack_require__.n(node_ponyfill);
;// ./node_modules/@walletconnect/jsonrpc-http-connection/dist/index.es.js
var jsonrpc_http_connection_dist_index_es_P=Object.defineProperty,jsonrpc_http_connection_dist_index_es_w=Object.defineProperties,jsonrpc_http_connection_dist_index_es_E=Object.getOwnPropertyDescriptors,jsonrpc_http_connection_dist_index_es_c=Object.getOwnPropertySymbols,dist_index_es_L=Object.prototype.hasOwnProperty,jsonrpc_http_connection_dist_index_es_O=Object.prototype.propertyIsEnumerable,jsonrpc_http_connection_dist_index_es_l=(r,t,e)=>t in r?jsonrpc_http_connection_dist_index_es_P(r,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):r[t]=e,jsonrpc_http_connection_dist_index_es_p=(r,t)=>{for(var e in t||(t={}))dist_index_es_L.call(t,e)&&jsonrpc_http_connection_dist_index_es_l(r,e,t[e]);if(jsonrpc_http_connection_dist_index_es_c)for(var e of jsonrpc_http_connection_dist_index_es_c(t))jsonrpc_http_connection_dist_index_es_O.call(t,e)&&jsonrpc_http_connection_dist_index_es_l(r,e,t[e]);return r},jsonrpc_http_connection_dist_index_es_v=(r,t)=>jsonrpc_http_connection_dist_index_es_w(r,jsonrpc_http_connection_dist_index_es_E(t));const jsonrpc_http_connection_dist_index_es_j={Accept:"application/json","Content-Type":"application/json"},dist_index_es_T="POST",jsonrpc_http_connection_dist_index_es_d={headers:jsonrpc_http_connection_dist_index_es_j,method:dist_index_es_T},jsonrpc_http_connection_dist_index_es_g=10;class jsonrpc_http_connection_dist_index_es_f{constructor(t,e=!1){if(this.url=t,this.disableProviderPing=e,this.events=new external_events_.EventEmitter,this.isAvailable=!1,this.registering=!1,!isHttpUrl(t))throw new Error(`Provided URL is not compatible with HTTP connection: ${t}`);this.url=t,this.disableProviderPing=e}get connected(){return this.isAvailable}get connecting(){return this.registering}on(t,e){this.events.on(t,e)}once(t,e){this.events.once(t,e)}off(t,e){this.events.off(t,e)}removeListener(t,e){this.events.removeListener(t,e)}async open(t=this.url){await this.register(t)}async close(){if(!this.isAvailable)throw new Error("Connection already closed");this.onClose()}async send(t){this.isAvailable||await this.register();try{const e=safeJsonStringify(t),s=await(await node_ponyfill_default()(this.url,jsonrpc_http_connection_dist_index_es_v(jsonrpc_http_connection_dist_index_es_p({},jsonrpc_http_connection_dist_index_es_d),{body:e}))).json();this.onPayload({data:s})}catch(e){this.onError(t.id,e)}}async register(t=this.url){if(!isHttpUrl(t))throw new Error(`Provided URL is not compatible with HTTP connection: ${t}`);if(this.registering){const e=this.events.getMaxListeners();return(this.events.listenerCount("register_error")>=e||this.events.listenerCount("open")>=e)&&this.events.setMaxListeners(e+1),new Promise((s,i)=>{this.events.once("register_error",n=>{this.resetMaxListeners(),i(n)}),this.events.once("open",()=>{if(this.resetMaxListeners(),typeof this.isAvailable>"u")return i(new Error("HTTP connection is missing or invalid"));s()})})}this.url=t,this.registering=!0;try{if(!this.disableProviderPing){const e=safeJsonStringify({id:1,jsonrpc:"2.0",method:"test",params:[]});await node_ponyfill_default()(t,jsonrpc_http_connection_dist_index_es_v(jsonrpc_http_connection_dist_index_es_p({},jsonrpc_http_connection_dist_index_es_d),{body:e}))}this.onOpen()}catch(e){const s=this.parseError(e);throw this.events.emit("register_error",s),this.onClose(),s}}onOpen(){this.isAvailable=!0,this.registering=!1,this.events.emit("open")}onClose(){this.isAvailable=!1,this.registering=!1,this.events.emit("close")}onPayload(t){if(typeof t.data>"u")return;const e=typeof t.data=="string"?safeJsonParse(t.data):t.data;this.events.emit("payload",e)}onError(t,e){const s=this.parseError(e),i=s.message||s.toString(),n=formatJsonRpcError(t,i);this.events.emit("payload",n)}parseError(t,e=this.url){return parseConnectionError(t,e,"HTTP")}resetMaxListeners(){this.events.getMaxListeners()>jsonrpc_http_connection_dist_index_es_g&&this.events.setMaxListeners(jsonrpc_http_connection_dist_index_es_g)}}
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/universal-provider/dist/index.es.js
const index_es_tt="error",universal_provider_dist_index_es_Nt="wss://relay.walletconnect.org",universal_provider_dist_index_es_St="wc",dist_index_es_Dt="universal_provider",universal_provider_dist_index_es_=`${universal_provider_dist_index_es_St}@2:${dist_index_es_Dt}:`,index_es_et="https://rpc.walletconnect.org/v1/",universal_provider_dist_index_es_w="generic",universal_provider_dist_index_es_qt=`${index_es_et}bundler`,universal_provider_dist_index_es_d={DEFAULT_CHAIN_CHANGED:"default_chain_changed"};function dist_index_es_jt(){}function dist_index_es_B(s){return s==null||typeof s!="object"&&typeof s!="function"}function dist_index_es_G(s){return ArrayBuffer.isView(s)&&!(s instanceof DataView)}function universal_provider_dist_index_es_Rt(s){if(dist_index_es_B(s))return s;if(Array.isArray(s)||dist_index_es_G(s)||s instanceof ArrayBuffer||typeof SharedArrayBuffer<"u"&&s instanceof SharedArrayBuffer)return s.slice(0);const t=Object.getPrototypeOf(s),e=t.constructor;if(s instanceof Date||s instanceof Map||s instanceof Set)return new e(s);if(s instanceof RegExp){const i=new e(s);return i.lastIndex=s.lastIndex,i}if(s instanceof DataView)return new e(s.buffer.slice(0));if(s instanceof Error){const i=new e(s.message);return i.stack=s.stack,i.name=s.name,i.cause=s.cause,i}if(typeof File<"u"&&s instanceof File)return new e([s],s.name,{type:s.type,lastModified:s.lastModified});if(typeof s=="object"){const i=Object.create(t);return Object.assign(i,s)}return s}function index_es_st(s){return typeof s=="object"&&s!==null}function dist_index_es_it(s){return Object.getOwnPropertySymbols(s).filter(t=>Object.prototype.propertyIsEnumerable.call(s,t))}function dist_index_es_rt(s){return s==null?s===void 0?"[object Undefined]":"[object Null]":Object.prototype.toString.call(s)}const universal_provider_dist_index_es_t="[object RegExp]",dist_index_es_nt="[object String]",index_es_at="[object Number]",dist_index_es_ct="[object Boolean]",index_es_ot="[object Arguments]",universal_provider_dist_index_es_Ut="[object Symbol]",universal_provider_dist_index_es_Ft="[object Date]",universal_provider_dist_index_es_Lt="[object Map]",universal_provider_dist_index_es_xt="[object Set]",universal_provider_dist_index_es_Mt="[object Array]",universal_provider_dist_index_es_Bt="[object ArrayBuffer]",universal_provider_dist_index_es_Gt="[object Object]",universal_provider_dist_index_es_Jt="[object DataView]",universal_provider_dist_index_es_zt="[object Uint8Array]",universal_provider_dist_index_es_kt="[object Uint8ClampedArray]",universal_provider_dist_index_es_Wt="[object Uint16Array]",universal_provider_dist_index_es_Kt="[object Uint32Array]",universal_provider_dist_index_es_Vt="[object Int8Array]",universal_provider_dist_index_es_Xt="[object Int16Array]",universal_provider_dist_index_es_Yt="[object Int32Array]",universal_provider_dist_index_es_Qt="[object Float32Array]",universal_provider_dist_index_es_Zt="[object Float64Array]";function universal_provider_dist_index_es_Tt(s,t){return universal_provider_dist_index_es_y(s,void 0,s,new Map,t)}function universal_provider_dist_index_es_y(s,t,e,i=new Map,r=void 0){const a=r?.(s,t,e,i);if(a!=null)return a;if(dist_index_es_B(s))return s;if(i.has(s))return i.get(s);if(Array.isArray(s)){const n=new Array(s.length);i.set(s,n);for(let c=0;c<s.length;c++)n[c]=universal_provider_dist_index_es_y(s[c],c,e,i,r);return Object.hasOwn(s,"index")&&(n.index=s.index),Object.hasOwn(s,"input")&&(n.input=s.input),n}if(s instanceof Date)return new Date(s.getTime());if(s instanceof RegExp){const n=new RegExp(s.source,s.flags);return n.lastIndex=s.lastIndex,n}if(s instanceof Map){const n=new Map;i.set(s,n);for(const[c,h]of s)n.set(c,universal_provider_dist_index_es_y(h,c,e,i,r));return n}if(s instanceof Set){const n=new Set;i.set(s,n);for(const c of s)n.add(universal_provider_dist_index_es_y(c,void 0,e,i,r));return n}if(typeof Buffer<"u"&&Buffer.isBuffer(s))return s.subarray();if(dist_index_es_G(s)){const n=new(Object.getPrototypeOf(s)).constructor(s.length);i.set(s,n);for(let c=0;c<s.length;c++)n[c]=universal_provider_dist_index_es_y(s[c],c,e,i,r);return n}if(s instanceof ArrayBuffer||typeof SharedArrayBuffer<"u"&&s instanceof SharedArrayBuffer)return s.slice(0);if(s instanceof DataView){const n=new DataView(s.buffer.slice(0),s.byteOffset,s.byteLength);return i.set(s,n),universal_provider_dist_index_es_g(n,s,e,i,r),n}if(typeof File<"u"&&s instanceof File){const n=new File([s],s.name,{type:s.type});return i.set(s,n),universal_provider_dist_index_es_g(n,s,e,i,r),n}if(s instanceof Blob){const n=new Blob([s],{type:s.type});return i.set(s,n),universal_provider_dist_index_es_g(n,s,e,i,r),n}if(s instanceof Error){const n=new s.constructor;return i.set(s,n),n.message=s.message,n.name=s.name,n.stack=s.stack,n.cause=s.cause,universal_provider_dist_index_es_g(n,s,e,i,r),n}if(typeof s=="object"&&universal_provider_dist_index_es_te(s)){const n=Object.create(Object.getPrototypeOf(s));return i.set(s,n),universal_provider_dist_index_es_g(n,s,e,i,r),n}return s}function universal_provider_dist_index_es_g(s,t,e=s,i,r){const a=[...Object.keys(t),...dist_index_es_it(t)];for(let n=0;n<a.length;n++){const c=a[n],h=Object.getOwnPropertyDescriptor(s,c);(h==null||h.writable)&&(s[c]=universal_provider_dist_index_es_y(t[c],c,e,i,r))}}function universal_provider_dist_index_es_te(s){switch(dist_index_es_rt(s)){case index_es_ot:case universal_provider_dist_index_es_Mt:case universal_provider_dist_index_es_Bt:case universal_provider_dist_index_es_Jt:case dist_index_es_ct:case universal_provider_dist_index_es_Ft:case universal_provider_dist_index_es_Qt:case universal_provider_dist_index_es_Zt:case universal_provider_dist_index_es_Vt:case universal_provider_dist_index_es_Xt:case universal_provider_dist_index_es_Yt:case universal_provider_dist_index_es_Lt:case index_es_at:case universal_provider_dist_index_es_Gt:case universal_provider_dist_index_es_t:case universal_provider_dist_index_es_xt:case dist_index_es_nt:case universal_provider_dist_index_es_Ut:case universal_provider_dist_index_es_zt:case universal_provider_dist_index_es_kt:case universal_provider_dist_index_es_Wt:case universal_provider_dist_index_es_Kt:return!0;default:return!1}}function index_es_ee(s,t){return universal_provider_dist_index_es_Tt(s,(e,i,r,a)=>{const n=t?.(e,i,r,a);if(n!=null)return n;if(typeof s=="object")switch(Object.prototype.toString.call(s)){case index_es_at:case dist_index_es_nt:case dist_index_es_ct:{const c=new s.constructor(s?.valueOf());return universal_provider_dist_index_es_g(c,s),c}case index_es_ot:{const c={};return universal_provider_dist_index_es_g(c,s),c.length=s.length,c[Symbol.iterator]=s[Symbol.iterator],c}default:return}})}function universal_provider_dist_index_es_ht(s){return index_es_ee(s)}function dist_index_es_pt(s){return s!==null&&typeof s=="object"&&dist_index_es_rt(s)==="[object Arguments]"}function dist_index_es_se(s){return dist_index_es_G(s)}function dist_index_es_ie(s){if(typeof s!="object"||s==null)return!1;if(Object.getPrototypeOf(s)===null)return!0;if(Object.prototype.toString.call(s)!=="[object Object]"){const e=s[Symbol.toStringTag];return e==null||!Object.getOwnPropertyDescriptor(s,Symbol.toStringTag)?.writable?!1:s.toString()===`[object ${e}]`}let t=s;for(;Object.getPrototypeOf(t)!==null;)t=Object.getPrototypeOf(t);return Object.getPrototypeOf(s)===t}function dist_index_es_re(s,...t){const e=t.slice(0,-1),i=t[t.length-1];let r=s;for(let a=0;a<e.length;a++){const n=e[a];r=U(r,n,i,new Map)}return r}function U(s,t,e,i){if(dist_index_es_B(s)&&(s=Object(s)),t==null||typeof t!="object")return s;if(i.has(t))return universal_provider_dist_index_es_Rt(i.get(t));if(i.set(t,s),Array.isArray(t)){t=t.slice();for(let a=0;a<t.length;a++)t[a]=t[a]??void 0}const r=[...Object.keys(t),...dist_index_es_it(t)];for(let a=0;a<r.length;a++){const n=r[a];let c=t[n],h=s[n];if(dist_index_es_pt(c)&&(c={...c}),dist_index_es_pt(h)&&(h={...h}),typeof Buffer<"u"&&Buffer.isBuffer(c)&&(c=universal_provider_dist_index_es_ht(c)),Array.isArray(c))if(typeof h=="object"&&h!=null){const j=[],R=Reflect.ownKeys(h);for(let f=0;f<R.length;f++){const X=R[f];j[X]=h[X]}h=j}else h=[];const v=e(h,c,n,s,t,i);v!=null?s[n]=v:Array.isArray(c)||index_es_st(h)&&index_es_st(c)?s[n]=U(h,c,e,i):h==null&&dist_index_es_ie(c)?s[n]=U({},c,e,i):h==null&&dist_index_es_se(c)?s[n]=universal_provider_dist_index_es_ht(c):(h===void 0||c!==void 0)&&(s[n]=c)}return s}function index_es_ne(s,...t){return dist_index_es_re(s,...t,dist_index_es_jt)}var dist_index_es_ae=Object.defineProperty,dist_index_es_ce=Object.defineProperties,index_es_oe=Object.getOwnPropertyDescriptors,universal_provider_dist_index_es_dt=Object.getOwnPropertySymbols,dist_index_es_he=Object.prototype.hasOwnProperty,dist_index_es_pe=Object.prototype.propertyIsEnumerable,universal_provider_dist_index_es_ut=(s,t,e)=>t in s?dist_index_es_ae(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,dist_index_es_F=(s,t)=>{for(var e in t||(t={}))dist_index_es_he.call(t,e)&&universal_provider_dist_index_es_ut(s,e,t[e]);if(universal_provider_dist_index_es_dt)for(var e of universal_provider_dist_index_es_dt(t))dist_index_es_pe.call(t,e)&&universal_provider_dist_index_es_ut(s,e,t[e]);return s},universal_provider_dist_index_es_de=(s,t)=>dist_index_es_ce(s,index_es_oe(t));function universal_provider_dist_index_es_p(s,t,e){var i;const r=index_es_Ye(s);return((i=t.rpcMap)==null?void 0:i[r.reference])||`${index_es_et}?chainId=${r.namespace}:${r.reference}&projectId=${e}`}function universal_provider_dist_index_es_P(s){return s.includes(":")?s.split(":")[1]:s}function dist_index_es_lt(s){return s.map(t=>`${t.split(":")[0]}:${t.split(":")[1]}`)}function dist_index_es_ue(s,t){const e=Object.keys(t.namespaces).filter(r=>r.includes(s));if(!e.length)return[];const i=[];return e.forEach(r=>{const a=t.namespaces[r].accounts;i.push(...a)}),i}function universal_provider_dist_index_es_J(s={},t={}){const e=universal_provider_dist_index_es_ft(s),i=universal_provider_dist_index_es_ft(t);return index_es_ne(e,i)}function universal_provider_dist_index_es_ft(s){var t,e,i,r;const a={};if(!index_es_qe(s))return a;for(const[n,c]of Object.entries(s)){const h=index_es_Tt(n)?[n]:c.chains,v=c.methods||[],j=c.events||[],R=c.rpcMap||{},f=index_es_pr(n);a[f]=universal_provider_dist_index_es_de(dist_index_es_F(dist_index_es_F({},a[f]),c),{chains:index_es_Q(h,(t=a[f])==null?void 0:t.chains),methods:index_es_Q(v,(e=a[f])==null?void 0:e.methods),events:index_es_Q(j,(i=a[f])==null?void 0:i.events),rpcMap:dist_index_es_F(dist_index_es_F({},R),(r=a[f])==null?void 0:r.rpcMap)})}return a}function universal_provider_dist_index_es_le(s){return s.includes(":")?s.split(":")[2]:s}function dist_index_es_mt(s){const t={};for(const[e,i]of Object.entries(s)){const r=i.methods||[],a=i.events||[],n=i.accounts||[],c=index_es_Tt(e)?[e]:i.chains?i.chains:dist_index_es_lt(i.accounts);t[e]={chains:c,methods:r,events:a,accounts:n}}return t}function universal_provider_dist_index_es_z(s){return typeof s=="number"?s:s.includes("0x")?parseInt(s,16):(s=s.includes(":")?s.split(":")[1]:s,isNaN(Number(s))?s:Number(s))}const dist_index_es_vt={},universal_provider_dist_index_es_o=s=>dist_index_es_vt[s],universal_provider_dist_index_es_k=(s,t)=>{dist_index_es_vt[s]=t};var dist_index_es_fe=Object.defineProperty,universal_provider_dist_index_es_me=(s,t,e)=>t in s?dist_index_es_fe(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_b=(s,t,e)=>universal_provider_dist_index_es_me(s,typeof t!="symbol"?t+"":t,e);class dist_index_es_ve{constructor(t){universal_provider_dist_index_es_b(this,"name","polkadot"),universal_provider_dist_index_es_b(this,"client"),universal_provider_dist_index_es_b(this,"httpProviders"),universal_provider_dist_index_es_b(this,"events"),universal_provider_dist_index_es_b(this,"namespace"),universal_provider_dist_index_es_b(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}getAccounts(){const t=this.namespace.accounts;return t?t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2])||[]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var dist_index_es_ge=Object.defineProperty,dist_index_es_Pe=Object.defineProperties,universal_provider_dist_index_es_we=Object.getOwnPropertyDescriptors,universal_provider_dist_index_es_gt=Object.getOwnPropertySymbols,dist_index_es_ye=Object.prototype.hasOwnProperty,universal_provider_dist_index_es_be=Object.prototype.propertyIsEnumerable,dist_index_es_W=(s,t,e)=>t in s?dist_index_es_ge(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_Pt=(s,t)=>{for(var e in t||(t={}))dist_index_es_ye.call(t,e)&&dist_index_es_W(s,e,t[e]);if(universal_provider_dist_index_es_gt)for(var e of universal_provider_dist_index_es_gt(t))universal_provider_dist_index_es_be.call(t,e)&&dist_index_es_W(s,e,t[e]);return s},universal_provider_dist_index_es_wt=(s,t)=>dist_index_es_Pe(s,universal_provider_dist_index_es_we(t)),dist_index_es_I=(s,t,e)=>dist_index_es_W(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_Ie{constructor(t){dist_index_es_I(this,"name","eip155"),dist_index_es_I(this,"client"),dist_index_es_I(this,"chainId"),dist_index_es_I(this,"namespace"),dist_index_es_I(this,"httpProviders"),dist_index_es_I(this,"events"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.httpProviders=this.createHttpProviders(),this.chainId=parseInt(this.getDefaultChain())}async request(t){switch(t.request.method){case"eth_requestAccounts":return this.getAccounts();case"eth_accounts":return this.getAccounts();case"wallet_switchEthereumChain":return await this.handleSwitchChain(t);case"eth_chainId":return parseInt(this.getDefaultChain());case"wallet_getCapabilities":return await this.getCapabilities(t);case"wallet_getCallsStatus":return await this.getCallStatus(t)}return this.namespace.methods.includes(t.request.method)?await this.client.request(t):this.getHttpProvider().request(t.request)}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(parseInt(t),e),this.chainId=parseInt(t),this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId.toString();if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(`${this.name}:${t}`,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=parseInt(universal_provider_dist_index_es_P(e));t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}getHttpProvider(){const t=this.chainId,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}async handleSwitchChain(t){var e,i;let r=t.request.params?(e=t.request.params[0])==null?void 0:e.chainId:"0x0";r=r.startsWith("0x")?r:`0x${r}`;const a=parseInt(r,16);if(this.isChainApproved(a))this.setDefaultChain(`${a}`);else if(this.namespace.methods.includes("wallet_switchEthereumChain"))await this.client.request({topic:t.topic,request:{method:t.request.method,params:[{chainId:r}]},chainId:(i=this.namespace.chains)==null?void 0:i[0]}),this.setDefaultChain(`${a}`);else throw new Error(`Failed to switch to chain 'eip155:${a}'. The chain is not approved or the wallet does not support 'wallet_switchEthereumChain' method.`);return null}isChainApproved(t){return this.namespace.chains.includes(`${this.name}:${t}`)}async getCapabilities(t){var e,i,r;const a=(i=(e=t.request)==null?void 0:e.params)==null?void 0:i[0];if(!a)throw new Error("Missing address parameter in `wallet_getCapabilities` request");const n=this.client.session.get(t.topic),c=((r=n?.sessionProperties)==null?void 0:r.capabilities)||{};if(c!=null&&c[a])return c?.[a];const h=await this.client.request(t);try{await this.client.session.update(t.topic,{sessionProperties:universal_provider_dist_index_es_wt(universal_provider_dist_index_es_Pt({},n.sessionProperties||{}),{capabilities:universal_provider_dist_index_es_wt(universal_provider_dist_index_es_Pt({},c||{}),{[a]:h})})})}catch(v){console.warn("Failed to update session with capabilities",v)}return h}async getCallStatus(t){var e,i;const r=this.client.session.get(t.topic),a=(e=r.sessionProperties)==null?void 0:e.bundler_name;if(a){const c=this.getBundlerUrl(t.chainId,a);try{return await this.getUserOperationReceipt(c,t)}catch(h){console.warn("Failed to fetch call status from bundler",h,c)}}const n=(i=r.sessionProperties)==null?void 0:i.bundler_url;if(n)try{return await this.getUserOperationReceipt(n,t)}catch(c){console.warn("Failed to fetch call status from custom bundler",c,n)}if(this.namespace.methods.includes(t.request.method))return await this.client.request(t);throw new Error("Fetching call status not approved by the wallet.")}async getUserOperationReceipt(t,e){var i;const r=new URL(t),a=await fetch(r,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(formatJsonRpcRequest("eth_getUserOperationReceipt",[(i=e.request.params)==null?void 0:i[0]]))});if(!a.ok)throw new Error(`Failed to fetch user operation receipt - ${a.status}`);return await a.json()}getBundlerUrl(t,e){return`${universal_provider_dist_index_es_qt}?projectId=${this.client.core.projectId}&chainId=${t}&bundler=${e}`}}var universal_provider_dist_index_es_$e=Object.defineProperty,dist_index_es_Oe=(s,t,e)=>t in s?universal_provider_dist_index_es_$e(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_$=(s,t,e)=>dist_index_es_Oe(s,typeof t!="symbol"?t+"":t,e);class dist_index_es_Ae{constructor(t){universal_provider_dist_index_es_$(this,"name","solana"),universal_provider_dist_index_es_$(this,"client"),universal_provider_dist_index_es_$(this,"httpProviders"),universal_provider_dist_index_es_$(this,"events"),universal_provider_dist_index_es_$(this,"namespace"),universal_provider_dist_index_es_$(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_He=Object.defineProperty,universal_provider_dist_index_es_Ee=(s,t,e)=>t in s?universal_provider_dist_index_es_He(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_O=(s,t,e)=>universal_provider_dist_index_es_Ee(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_Ce{constructor(t){universal_provider_dist_index_es_O(this,"name","cosmos"),universal_provider_dist_index_es_O(this,"client"),universal_provider_dist_index_es_O(this,"httpProviders"),universal_provider_dist_index_es_O(this,"events"),universal_provider_dist_index_es_O(this,"namespace"),universal_provider_dist_index_es_O(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${this.chainId}`)}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var dist_index_es_Ne=Object.defineProperty,dist_index_es_Se=(s,t,e)=>t in s?dist_index_es_Ne(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,dist_index_es_A=(s,t,e)=>dist_index_es_Se(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_De{constructor(t){dist_index_es_A(this,"name","algorand"),dist_index_es_A(this,"client"),dist_index_es_A(this,"httpProviders"),dist_index_es_A(this,"events"),dist_index_es_A(this,"namespace"),dist_index_es_A(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){if(!this.httpProviders[t]){const i=e||universal_provider_dist_index_es_p(`${this.name}:${t}`,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);this.setHttpProvider(t,i)}this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${this.chainId}`)}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;t[e]=this.createHttpProvider(e,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);return typeof i>"u"?void 0:new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_qe=Object.defineProperty,universal_provider_dist_index_es_je=(s,t,e)=>t in s?universal_provider_dist_index_es_qe(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_H=(s,t,e)=>universal_provider_dist_index_es_je(s,typeof t!="symbol"?t+"":t,e);class dist_index_es_Re{constructor(t){universal_provider_dist_index_es_H(this,"name","cip34"),universal_provider_dist_index_es_H(this,"client"),universal_provider_dist_index_es_H(this,"httpProviders"),universal_provider_dist_index_es_H(this,"events"),universal_provider_dist_index_es_H(this,"namespace"),universal_provider_dist_index_es_H(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${this.chainId}`)}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{const i=this.getCardanoRPCUrl(e),r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,i)}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}getCardanoRPCUrl(t){const e=this.namespace.rpcMap;if(e)return e[t]}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||this.getCardanoRPCUrl(t);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_e=Object.defineProperty,universal_provider_dist_index_es_Ue=(s,t,e)=>t in s?universal_provider_dist_index_es_e(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_E=(s,t,e)=>universal_provider_dist_index_es_Ue(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_Fe{constructor(t){universal_provider_dist_index_es_E(this,"name","elrond"),universal_provider_dist_index_es_E(this,"client"),universal_provider_dist_index_es_E(this,"httpProviders"),universal_provider_dist_index_es_E(this,"events"),universal_provider_dist_index_es_E(this,"namespace"),universal_provider_dist_index_es_E(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_Le=Object.defineProperty,dist_index_es_xe=(s,t,e)=>t in s?universal_provider_dist_index_es_Le(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_C=(s,t,e)=>dist_index_es_xe(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_Me{constructor(t){universal_provider_dist_index_es_C(this,"name","multiversx"),universal_provider_dist_index_es_C(this,"client"),universal_provider_dist_index_es_C(this,"httpProviders"),universal_provider_dist_index_es_C(this,"events"),universal_provider_dist_index_es_C(this,"namespace"),universal_provider_dist_index_es_C(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;const r=universal_provider_dist_index_es_P(e);t[r]=this.createHttpProvider(r,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_Be=Object.defineProperty,universal_provider_dist_index_es_Ge=(s,t,e)=>t in s?universal_provider_dist_index_es_Be(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_N=(s,t,e)=>universal_provider_dist_index_es_Ge(s,typeof t!="symbol"?t+"":t,e);class dist_index_es_Je{constructor(t){universal_provider_dist_index_es_N(this,"name","near"),universal_provider_dist_index_es_N(this,"client"),universal_provider_dist_index_es_N(this,"httpProviders"),universal_provider_dist_index_es_N(this,"events"),universal_provider_dist_index_es_N(this,"namespace"),universal_provider_dist_index_es_N(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){if(this.chainId=t,!this.httpProviders[t]){const i=e||universal_provider_dist_index_es_p(`${this.name}:${t}`,this.namespace);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);this.setHttpProvider(t,i)}this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${this.chainId}`)}getAccounts(){const t=this.namespace.accounts;return t?t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2])||[]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{var i;t[e]=this.createHttpProvider(e,(i=this.namespace.rpcMap)==null?void 0:i[e])}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace);return typeof i>"u"?void 0:new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var dist_index_es_ze=Object.defineProperty,universal_provider_dist_index_es_ke=(s,t,e)=>t in s?dist_index_es_ze(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_S=(s,t,e)=>universal_provider_dist_index_es_ke(s,typeof t!="symbol"?t+"":t,e);class dist_index_es_We{constructor(t){universal_provider_dist_index_es_S(this,"name","tezos"),universal_provider_dist_index_es_S(this,"client"),universal_provider_dist_index_es_S(this,"httpProviders"),universal_provider_dist_index_es_S(this,"events"),universal_provider_dist_index_es_S(this,"namespace"),universal_provider_dist_index_es_S(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace=Object.assign(this.namespace,t)}requestAccounts(){return this.getAccounts()}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider().request(t.request)}setDefaultChain(t,e){if(this.chainId=t,!this.httpProviders[t]){const i=e||universal_provider_dist_index_es_p(`${this.name}:${t}`,this.namespace);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);this.setHttpProvider(t,i)}this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${this.chainId}`)}getAccounts(){const t=this.namespace.accounts;return t?t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2])||[]:[]}createHttpProviders(){const t={};return this.namespace.chains.forEach(e=>{t[e]=this.createHttpProvider(e)}),t}getHttpProvider(){const t=`${this.name}:${this.chainId}`,e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace);return typeof i>"u"?void 0:new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i))}}var universal_provider_dist_index_es_Ke=Object.defineProperty,universal_provider_dist_index_es_Ve=(s,t,e)=>t in s?universal_provider_dist_index_es_Ke(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,index_es_D=(s,t,e)=>universal_provider_dist_index_es_Ve(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_Xe{constructor(t){index_es_D(this,"name",universal_provider_dist_index_es_w),index_es_D(this,"client"),index_es_D(this,"httpProviders"),index_es_D(this,"events"),index_es_D(this,"namespace"),index_es_D(this,"chainId"),this.namespace=t.namespace,this.events=universal_provider_dist_index_es_o("events"),this.client=universal_provider_dist_index_es_o("client"),this.chainId=this.getDefaultChain(),this.httpProviders=this.createHttpProviders()}updateNamespace(t){this.namespace.chains=[...new Set((this.namespace.chains||[]).concat(t.chains||[]))],this.namespace.accounts=[...new Set((this.namespace.accounts||[]).concat(t.accounts||[]))],this.namespace.methods=[...new Set((this.namespace.methods||[]).concat(t.methods||[]))],this.namespace.events=[...new Set((this.namespace.events||[]).concat(t.events||[]))],this.httpProviders=this.createHttpProviders()}requestAccounts(){return this.getAccounts()}request(t){return this.namespace.methods.includes(t.request.method)?this.client.request(t):this.getHttpProvider(t.chainId).request(t.request)}setDefaultChain(t,e){this.httpProviders[t]||this.setHttpProvider(t,e),this.chainId=t,this.events.emit(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,`${this.name}:${t}`)}getDefaultChain(){if(this.chainId)return this.chainId;if(this.namespace.defaultChain)return this.namespace.defaultChain;const t=this.namespace.chains[0];if(!t)throw new Error("ChainId not found");return t.split(":")[1]}getAccounts(){const t=this.namespace.accounts;return t?[...new Set(t.filter(e=>e.split(":")[1]===this.chainId.toString()).map(e=>e.split(":")[2]))]:[]}createHttpProviders(){var t,e;const i={};return(e=(t=this.namespace)==null?void 0:t.accounts)==null||e.forEach(r=>{const a=index_es_Ye(r);i[`${a.namespace}:${a.reference}`]=this.createHttpProvider(r)}),i}getHttpProvider(t){const e=this.httpProviders[t];if(typeof e>"u")throw new Error(`JSON-RPC provider for ${t} not found`);return e}setHttpProvider(t,e){const i=this.createHttpProvider(t,e);i&&(this.httpProviders[t]=i)}createHttpProvider(t,e){const i=e||universal_provider_dist_index_es_p(t,this.namespace,this.client.core.projectId);if(!i)throw new Error(`No RPC url provided for chainId: ${t}`);return new jsonrpc_provider_dist_index_es_o(new jsonrpc_http_connection_dist_index_es_f(i,universal_provider_dist_index_es_o("disableProviderPing")))}}var universal_provider_dist_index_es_Ye=Object.defineProperty,universal_provider_dist_index_es_Qe=Object.defineProperties,universal_provider_dist_index_es_Ze=Object.getOwnPropertyDescriptors,universal_provider_dist_index_es_yt=Object.getOwnPropertySymbols,universal_provider_dist_index_es_Te=Object.prototype.hasOwnProperty,dist_index_es_ts=Object.prototype.propertyIsEnumerable,universal_provider_dist_index_es_K=(s,t,e)=>t in s?universal_provider_dist_index_es_Ye(s,t,{enumerable:!0,configurable:!0,writable:!0,value:e}):s[t]=e,universal_provider_dist_index_es_L=(s,t)=>{for(var e in t||(t={}))universal_provider_dist_index_es_Te.call(t,e)&&universal_provider_dist_index_es_K(s,e,t[e]);if(universal_provider_dist_index_es_yt)for(var e of universal_provider_dist_index_es_yt(t))dist_index_es_ts.call(t,e)&&universal_provider_dist_index_es_K(s,e,t[e]);return s},universal_provider_dist_index_es_V=(s,t)=>universal_provider_dist_index_es_Qe(s,universal_provider_dist_index_es_Ze(t)),dist_index_es_u=(s,t,e)=>universal_provider_dist_index_es_K(s,typeof t!="symbol"?t+"":t,e);class universal_provider_dist_index_es_x{constructor(t){dist_index_es_u(this,"client"),dist_index_es_u(this,"namespaces"),dist_index_es_u(this,"optionalNamespaces"),dist_index_es_u(this,"sessionProperties"),dist_index_es_u(this,"scopedProperties"),dist_index_es_u(this,"events",new (external_events_default())),dist_index_es_u(this,"rpcProviders",{}),dist_index_es_u(this,"session"),dist_index_es_u(this,"providerOpts"),dist_index_es_u(this,"logger"),dist_index_es_u(this,"uri"),dist_index_es_u(this,"disableProviderPing",!1),this.providerOpts=t,this.logger=typeof t?.logger<"u"&&typeof t?.logger!="string"?t.logger:pino_default()(logger_dist_index_es_k({level:t?.logger||index_es_tt})),this.disableProviderPing=t?.disableProviderPing||!1}static async init(t){const e=new universal_provider_dist_index_es_x(t);return await e.initialize(),e}async request(t,e,i){const[r,a]=this.validateChain(e);if(!this.session)throw new Error("Please call connect() before request()");return await this.getProvider(r).request({request:universal_provider_dist_index_es_L({},t),chainId:`${r}:${a}`,topic:this.session.topic,expiry:i})}sendAsync(t,e,i,r){const a=new Date().getTime();this.request(t,i,r).then(n=>e(null,formatJsonRpcResult(a,n))).catch(n=>e(n,void 0))}async enable(){if(!this.client)throw new Error("Sign Client not initialized");return this.session||await this.connect({namespaces:this.namespaces,optionalNamespaces:this.optionalNamespaces,sessionProperties:this.sessionProperties,scopedProperties:this.scopedProperties}),await this.requestAccounts()}async disconnect(){var t;if(!this.session)throw new Error("Please call connect() before enable()");await this.client.disconnect({topic:(t=this.session)==null?void 0:t.topic,reason:index_es_de("USER_DISCONNECTED")}),await this.cleanup()}async connect(t){if(!this.client)throw new Error("Sign Client not initialized");if(this.setNamespaces(t),await this.cleanupPendingPairings(),!t.skipPairing)return await this.pair(t.pairingTopic)}async authenticate(t,e){if(!this.client)throw new Error("Sign Client not initialized");this.setNamespaces(t),await this.cleanupPendingPairings();const{uri:i,response:r}=await this.client.authenticate(t,e);i&&(this.uri=i,this.events.emit("display_uri",i));const a=await r();if(this.session=a.session,this.session){const n=dist_index_es_mt(this.session.namespaces);this.namespaces=universal_provider_dist_index_es_J(this.namespaces,n),await this.persist("namespaces",this.namespaces),this.onConnect()}return a}on(t,e){this.events.on(t,e)}once(t,e){this.events.once(t,e)}removeListener(t,e){this.events.removeListener(t,e)}off(t,e){this.events.off(t,e)}get isWalletConnect(){return!0}async pair(t){const{uri:e,approval:i}=await this.client.connect({pairingTopic:t,requiredNamespaces:this.namespaces,optionalNamespaces:this.optionalNamespaces,sessionProperties:this.sessionProperties,scopedProperties:this.scopedProperties});e&&(this.uri=e,this.events.emit("display_uri",e));const r=await i();this.session=r;const a=dist_index_es_mt(r.namespaces);return this.namespaces=universal_provider_dist_index_es_J(this.namespaces,a),await this.persist("namespaces",this.namespaces),await this.persist("optionalNamespaces",this.optionalNamespaces),this.onConnect(),this.session}setDefaultChain(t,e){try{if(!this.session)return;const[i,r]=this.validateChain(t),a=this.getProvider(i);a.name===universal_provider_dist_index_es_w?a.setDefaultChain(`${i}:${r}`,e):a.setDefaultChain(r,e)}catch(i){if(!/Please call connect/.test(i.message))throw i}}async cleanupPendingPairings(t={}){this.logger.info("Cleaning up inactive pairings...");const e=this.client.pairing.getAll();if(index_es_$e(e)){for(const i of e)t.deletePairings?this.client.core.expirer.set(i.topic,0):await this.client.core.relayer.subscriber.unsubscribe(i.topic);this.logger.info(`Inactive pairings cleared: ${e.length}`)}}abortPairingAttempt(){this.logger.warn("abortPairingAttempt is deprecated. This is now a no-op.")}async checkStorage(){this.namespaces=await this.getFromStore("namespaces")||{},this.optionalNamespaces=await this.getFromStore("optionalNamespaces")||{},this.session&&this.createProviders()}async initialize(){this.logger.trace("Initialized"),await this.createClient(),await this.checkStorage(),this.registerEventListeners()}async createClient(){var t,e;if(this.client=this.providerOpts.client||await sign_client_dist_index_es_Ee.init({core:this.providerOpts.core,logger:this.providerOpts.logger||index_es_tt,relayUrl:this.providerOpts.relayUrl||universal_provider_dist_index_es_Nt,projectId:this.providerOpts.projectId,metadata:this.providerOpts.metadata,storageOptions:this.providerOpts.storageOptions,storage:this.providerOpts.storage,name:this.providerOpts.name,customStoragePrefix:this.providerOpts.customStoragePrefix,telemetryEnabled:this.providerOpts.telemetryEnabled}),this.providerOpts.session)try{this.session=this.client.session.get(this.providerOpts.session.topic)}catch(i){throw this.logger.error("Failed to get session",i),new Error(`The provided session: ${(e=(t=this.providerOpts)==null?void 0:t.session)==null?void 0:e.topic} doesn't exist in the Sign client`)}else{const i=this.client.session.getAll();this.session=i[0]}this.logger.trace("SignClient Initialized")}createProviders(){if(!this.client)throw new Error("Sign Client not initialized");if(!this.session)throw new Error("Session not initialized. Please call connect() before enable()");const t=[...new Set(Object.keys(this.session.namespaces).map(e=>index_es_pr(e)))];universal_provider_dist_index_es_k("client",this.client),universal_provider_dist_index_es_k("events",this.events),universal_provider_dist_index_es_k("disableProviderPing",this.disableProviderPing),t.forEach(e=>{if(!this.session)return;const i=dist_index_es_ue(e,this.session),r=dist_index_es_lt(i),a=universal_provider_dist_index_es_J(this.namespaces,this.optionalNamespaces),n=universal_provider_dist_index_es_V(universal_provider_dist_index_es_L({},a[e]),{accounts:i,chains:r});switch(e){case"eip155":this.rpcProviders[e]=new universal_provider_dist_index_es_Ie({namespace:n});break;case"algorand":this.rpcProviders[e]=new universal_provider_dist_index_es_De({namespace:n});break;case"solana":this.rpcProviders[e]=new dist_index_es_Ae({namespace:n});break;case"cosmos":this.rpcProviders[e]=new universal_provider_dist_index_es_Ce({namespace:n});break;case"polkadot":this.rpcProviders[e]=new dist_index_es_ve({namespace:n});break;case"cip34":this.rpcProviders[e]=new dist_index_es_Re({namespace:n});break;case"elrond":this.rpcProviders[e]=new universal_provider_dist_index_es_Fe({namespace:n});break;case"multiversx":this.rpcProviders[e]=new universal_provider_dist_index_es_Me({namespace:n});break;case"near":this.rpcProviders[e]=new dist_index_es_Je({namespace:n});break;case"tezos":this.rpcProviders[e]=new dist_index_es_We({namespace:n});break;default:this.rpcProviders[universal_provider_dist_index_es_w]?this.rpcProviders[universal_provider_dist_index_es_w].updateNamespace(n):this.rpcProviders[universal_provider_dist_index_es_w]=new universal_provider_dist_index_es_Xe({namespace:n})}})}registerEventListeners(){if(typeof this.client>"u")throw new Error("Sign Client is not initialized");this.client.on("session_ping",t=>{var e;const{topic:i}=t;i===((e=this.session)==null?void 0:e.topic)&&this.events.emit("session_ping",t)}),this.client.on("session_event",t=>{var e;const{params:i,topic:r}=t;if(r!==((e=this.session)==null?void 0:e.topic))return;const{event:a}=i;if(a.name==="accountsChanged"){const n=a.data;n&&index_es_$e(n)&&this.events.emit("accountsChanged",n.map(universal_provider_dist_index_es_le))}else if(a.name==="chainChanged"){const n=i.chainId,c=i.event.data,h=index_es_pr(n),v=universal_provider_dist_index_es_z(n)!==universal_provider_dist_index_es_z(c)?`${h}:${universal_provider_dist_index_es_z(c)}`:n;this.onChainChanged(v)}else this.events.emit(a.name,a.data);this.events.emit("session_event",t)}),this.client.on("session_update",({topic:t,params:e})=>{var i,r;if(t!==((i=this.session)==null?void 0:i.topic))return;const{namespaces:a}=e,n=(r=this.client)==null?void 0:r.session.get(t);this.session=universal_provider_dist_index_es_V(universal_provider_dist_index_es_L({},n),{namespaces:a}),this.onSessionUpdate(),this.events.emit("session_update",{topic:t,params:e})}),this.client.on("session_delete",async t=>{var e;t.topic===((e=this.session)==null?void 0:e.topic)&&(await this.cleanup(),this.events.emit("session_delete",t),this.events.emit("disconnect",universal_provider_dist_index_es_V(universal_provider_dist_index_es_L({},index_es_de("USER_DISCONNECTED")),{data:t.topic})))}),this.on(universal_provider_dist_index_es_d.DEFAULT_CHAIN_CHANGED,t=>{this.onChainChanged(t,!0)})}getProvider(t){return this.rpcProviders[t]||this.rpcProviders[universal_provider_dist_index_es_w]}onSessionUpdate(){Object.keys(this.rpcProviders).forEach(t=>{var e;this.getProvider(t).updateNamespace((e=this.session)==null?void 0:e.namespaces[t])})}setNamespaces(t){const{namespaces:e,optionalNamespaces:i,sessionProperties:r,scopedProperties:a}=t;e&&Object.keys(e).length&&(this.namespaces=e),i&&Object.keys(i).length&&(this.optionalNamespaces=i),this.sessionProperties=r,this.scopedProperties=a}validateChain(t){const[e,i]=t?.split(":")||["",""];if(!this.namespaces||!Object.keys(this.namespaces).length)return[e,i];if(e&&!Object.keys(this.namespaces||{}).map(n=>index_es_pr(n)).includes(e))throw new Error(`Namespace '${e}' is not configured. Please call connect() first with namespace config.`);if(e&&i)return[e,i];const r=index_es_pr(Object.keys(this.namespaces)[0]),a=this.rpcProviders[r].getDefaultChain();return[r,a]}async requestAccounts(){const[t]=this.validateChain();return await this.getProvider(t).requestAccounts()}async onChainChanged(t,e=!1){if(!this.namespaces)return;const[i,r]=this.validateChain(t);r&&(e||this.getProvider(i).setDefaultChain(r),this.namespaces[i]?this.namespaces[i].defaultChain=r:this.namespaces[`${i}:${r}`]?this.namespaces[`${i}:${r}`].defaultChain=r:this.namespaces[`${i}:${r}`]={defaultChain:r},this.events.emit("chainChanged",r),await this.persist("namespaces",this.namespaces))}onConnect(){this.createProviders(),this.events.emit("connect",{session:this.session})}async cleanup(){this.namespaces=void 0,this.optionalNamespaces=void 0,this.sessionProperties=void 0,await this.deleteFromStore("namespaces"),await this.deleteFromStore("optionalNamespaces"),await this.deleteFromStore("sessionProperties"),this.session=void 0,await this.cleanupPendingPairings({deletePairings:!0}),await this.cleanupStorage()}async persist(t,e){var i;const r=((i=this.session)==null?void 0:i.topic)||"";await this.client.core.storage.setItem(`${universal_provider_dist_index_es_}/${t}${r}`,e)}async getFromStore(t){var e;const i=((e=this.session)==null?void 0:e.topic)||"";return await this.client.core.storage.getItem(`${universal_provider_dist_index_es_}/${t}${i}`)}async deleteFromStore(t){var e;const i=((e=this.session)==null?void 0:e.topic)||"";await this.client.core.storage.removeItem(`${universal_provider_dist_index_es_}/${t}${i}`)}async cleanupStorage(){var t;try{if(((t=this.client)==null?void 0:t.session.length)>0)return;const e=await this.client.core.storage.getKeys();for(const i of e)i.startsWith(universal_provider_dist_index_es_)&&await this.client.core.storage.removeItem(i)}catch(e){this.logger.warn("Failed to cleanup storage",e)}}}const index_es_es=universal_provider_dist_index_es_x;
//# sourceMappingURL=index.es.js.map

;// ./node_modules/@walletconnect/ethereum-provider/dist/index.es.js
const ethereum_provider_dist_index_es_T="wc",ethereum_provider_dist_index_es_$="ethereum_provider",ethereum_provider_dist_index_es_j=`${ethereum_provider_dist_index_es_T}@2:${ethereum_provider_dist_index_es_$}:`,dist_index_es_q="https://rpc.walletconnect.org/v1/",ethereum_provider_dist_index_es_u=["eth_sendTransaction","personal_sign"],ethereum_provider_dist_index_es_M=["eth_accounts","eth_requestAccounts","eth_sendRawTransaction","eth_sign","eth_signTransaction","eth_signTypedData","eth_signTypedData_v3","eth_signTypedData_v4","eth_sendTransaction","personal_sign","wallet_switchEthereumChain","wallet_addEthereumChain","wallet_getPermissions","wallet_requestPermissions","wallet_registerOnboarding","wallet_watchAsset","wallet_scanQRCode","wallet_sendCalls","wallet_getCapabilities","wallet_getCallsStatus","wallet_showCallsStatus"],ethereum_provider_dist_index_es_m=["chainChanged","accountsChanged"],ethereum_provider_dist_index_es_O=["chainChanged","accountsChanged","message","disconnect","connect"];var ethereum_provider_dist_index_es_N=Object.defineProperty,dist_index_es_D=Object.defineProperties,index_es_U=Object.getOwnPropertyDescriptors,ethereum_provider_dist_index_es_P=Object.getOwnPropertySymbols,ethereum_provider_dist_index_es_Q=Object.prototype.hasOwnProperty,ethereum_provider_dist_index_es_L=Object.prototype.propertyIsEnumerable,ethereum_provider_dist_index_es_y=(a,t,s)=>t in a?ethereum_provider_dist_index_es_N(a,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):a[t]=s,ethereum_provider_dist_index_es_g=(a,t)=>{for(var s in t||(t={}))ethereum_provider_dist_index_es_Q.call(t,s)&&ethereum_provider_dist_index_es_y(a,s,t[s]);if(ethereum_provider_dist_index_es_P)for(var s of ethereum_provider_dist_index_es_P(t))ethereum_provider_dist_index_es_L.call(t,s)&&ethereum_provider_dist_index_es_y(a,s,t[s]);return a},ethereum_provider_dist_index_es_=(a,t)=>dist_index_es_D(a,index_es_U(t)),ethereum_provider_dist_index_es_o=(a,t,s)=>ethereum_provider_dist_index_es_y(a,typeof t!="symbol"?t+"":t,s);function ethereum_provider_dist_index_es_v(a){return Number(a[0].split(":")[1])}function ethereum_provider_dist_index_es_C(a){return`0x${a.toString(16)}`}function ethereum_provider_dist_index_es_x(a){const{chains:t,optionalChains:s,methods:i,optionalMethods:e,events:n,optionalEvents:h,rpcMap:l}=a;if(!index_es_$e(t))throw new Error("Invalid chains");const r={chains:t,methods:i||ethereum_provider_dist_index_es_u,events:n||ethereum_provider_dist_index_es_m,rpcMap:ethereum_provider_dist_index_es_g({},t.length?{[ethereum_provider_dist_index_es_v(t)]:l[ethereum_provider_dist_index_es_v(t)]}:{})},d=n?.filter(p=>!ethereum_provider_dist_index_es_m.includes(p)),c=i?.filter(p=>!ethereum_provider_dist_index_es_u.includes(p));if(!s&&!h&&!e&&!(d!=null&&d.length)&&!(c!=null&&c.length))return{required:t.length?r:void 0};const I=d?.length&&c?.length||!s,f={chains:[...new Set(I?r.chains.concat(s||[]):s)],methods:[...new Set(r.methods.concat(e!=null&&e.length?e:ethereum_provider_dist_index_es_M))],events:[...new Set(r.events.concat(h!=null&&h.length?h:ethereum_provider_dist_index_es_O))],rpcMap:l};return{required:t.length?r:void 0,optional:s.length?f:void 0}}class ethereum_provider_dist_index_es_w{constructor(){ethereum_provider_dist_index_es_o(this,"events",new external_events_.EventEmitter),ethereum_provider_dist_index_es_o(this,"namespace","eip155"),ethereum_provider_dist_index_es_o(this,"accounts",[]),ethereum_provider_dist_index_es_o(this,"signer"),ethereum_provider_dist_index_es_o(this,"chainId",1),ethereum_provider_dist_index_es_o(this,"modal"),ethereum_provider_dist_index_es_o(this,"rpc"),ethereum_provider_dist_index_es_o(this,"STORAGE_KEY",ethereum_provider_dist_index_es_j),ethereum_provider_dist_index_es_o(this,"on",(t,s)=>(this.events.on(t,s),this)),ethereum_provider_dist_index_es_o(this,"once",(t,s)=>(this.events.once(t,s),this)),ethereum_provider_dist_index_es_o(this,"removeListener",(t,s)=>(this.events.removeListener(t,s),this)),ethereum_provider_dist_index_es_o(this,"off",(t,s)=>(this.events.off(t,s),this)),ethereum_provider_dist_index_es_o(this,"parseAccount",t=>this.isCompatibleChainId(t)?this.parseAccountId(t).address:t),this.signer={},this.rpc={}}static async init(t){const s=new ethereum_provider_dist_index_es_w;return await s.initialize(t),s}async request(t,s){return await this.signer.request(t,this.formatChainId(this.chainId),s)}sendAsync(t,s,i){this.signer.sendAsync(t,s,this.formatChainId(this.chainId),i)}get connected(){return this.signer.client?this.signer.client.core.relayer.connected:!1}get connecting(){return this.signer.client?this.signer.client.core.relayer.connecting:!1}async enable(){return this.session||await this.connect(),await this.request({method:"eth_requestAccounts"})}async connect(t){if(!this.signer.client)throw new Error("Provider not initialized. Call init() first");this.loadConnectOpts(t);const{required:s,optional:i}=ethereum_provider_dist_index_es_x(this.rpc);try{const e=await new Promise(async(h,l)=>{var r;this.rpc.showQrModal&&((r=this.modal)==null||r.subscribeModal(c=>{!c.open&&!this.signer.session&&(this.signer.abortPairingAttempt(),l(new Error("Connection request reset. Please try again.")))}));const d=t!=null&&t.scopedProperties?{[this.namespace]:t.scopedProperties}:void 0;await this.signer.connect(ethereum_provider_dist_index_es_(ethereum_provider_dist_index_es_g({namespaces:ethereum_provider_dist_index_es_g({},s&&{[this.namespace]:s})},i&&{optionalNamespaces:{[this.namespace]:i}}),{pairingTopic:t?.pairingTopic,scopedProperties:d})).then(c=>{h(c)}).catch(c=>{l(new Error(c.message))})});if(!e)return;const n=index_es_Kr(e.namespaces,[this.namespace]);this.setChainIds(this.rpc.chains.length?this.rpc.chains:n),this.setAccounts(n),this.events.emit("connect",{chainId:ethereum_provider_dist_index_es_C(this.chainId)})}catch(e){throw this.signer.logger.error(e),e}finally{this.modal&&this.modal.closeModal()}}async authenticate(t,s){if(!this.signer.client)throw new Error("Provider not initialized. Call init() first");this.loadConnectOpts({chains:t?.chains});try{const i=await new Promise(async(n,h)=>{var l;this.rpc.showQrModal&&((l=this.modal)==null||l.subscribeModal(r=>{!r.open&&!this.signer.session&&(this.signer.abortPairingAttempt(),h(new Error("Connection request reset. Please try again.")))})),await this.signer.authenticate(ethereum_provider_dist_index_es_(ethereum_provider_dist_index_es_g({},t),{chains:this.rpc.chains}),s).then(r=>{n(r)}).catch(r=>{h(new Error(r.message))})}),e=i.session;if(e){const n=index_es_Kr(e.namespaces,[this.namespace]);this.setChainIds(this.rpc.chains.length?this.rpc.chains:n),this.setAccounts(n),this.events.emit("connect",{chainId:ethereum_provider_dist_index_es_C(this.chainId)})}return i}catch(i){throw this.signer.logger.error(i),i}finally{this.modal&&this.modal.closeModal()}}async disconnect(){this.session&&await this.signer.disconnect(),this.reset()}get isWalletConnect(){return!0}get session(){return this.signer.session}registerEventListeners(){this.signer.on("session_event",t=>{const{params:s}=t,{event:i}=s;i.name==="accountsChanged"?(this.accounts=this.parseAccounts(i.data),this.events.emit("accountsChanged",this.accounts)):i.name==="chainChanged"?this.setChainId(this.formatChainId(i.data)):this.events.emit(i.name,i.data),this.events.emit("session_event",t)}),this.signer.on("chainChanged",t=>{const s=parseInt(t);this.chainId=s,this.events.emit("chainChanged",ethereum_provider_dist_index_es_C(this.chainId)),this.persist()}),this.signer.on("session_update",t=>{this.events.emit("session_update",t)}),this.signer.on("session_delete",t=>{this.reset(),this.events.emit("session_delete",t),this.events.emit("disconnect",ethereum_provider_dist_index_es_(ethereum_provider_dist_index_es_g({},index_es_de("USER_DISCONNECTED")),{data:t.topic,name:"USER_DISCONNECTED"}))}),this.signer.on("display_uri",t=>{var s,i;this.rpc.showQrModal&&((s=this.modal)==null||s.closeModal(),(i=this.modal)==null||i.openModal({uri:t})),this.events.emit("display_uri",t)})}switchEthereumChain(t){this.request({method:"wallet_switchEthereumChain",params:[{chainId:t.toString(16)}]})}isCompatibleChainId(t){return typeof t=="string"?t.startsWith(`${this.namespace}:`):!1}formatChainId(t){return`${this.namespace}:${t}`}parseChainId(t){return Number(t.split(":")[1])}setChainIds(t){const s=t.filter(i=>this.isCompatibleChainId(i)).map(i=>this.parseChainId(i));s.length&&(this.chainId=s[0],this.events.emit("chainChanged",ethereum_provider_dist_index_es_C(this.chainId)),this.persist())}setChainId(t){if(this.isCompatibleChainId(t)){const s=this.parseChainId(t);this.chainId=s,this.switchEthereumChain(s)}}parseAccountId(t){const[s,i,e]=t.split(":");return{chainId:`${s}:${i}`,address:e}}setAccounts(t){this.accounts=t.filter(s=>this.parseChainId(this.parseAccountId(s).chainId)===this.chainId).map(s=>this.parseAccountId(s).address),this.events.emit("accountsChanged",this.accounts)}getRpcConfig(t){var s,i;const e=(s=t?.chains)!=null?s:[],n=(i=t?.optionalChains)!=null?i:[],h=e.concat(n);if(!h.length)throw new Error("No chains specified in either `chains` or `optionalChains`");const l=e.length?t?.methods||ethereum_provider_dist_index_es_u:[],r=e.length?t?.events||ethereum_provider_dist_index_es_m:[],d=t?.optionalMethods||[],c=t?.optionalEvents||[],I=t?.rpcMap||this.buildRpcMap(h,t.projectId),f=t?.qrModalOptions||void 0;return{chains:e?.map(p=>this.formatChainId(p)),optionalChains:n.map(p=>this.formatChainId(p)),methods:l,events:r,optionalMethods:d,optionalEvents:c,rpcMap:I,showQrModal:!!(t!=null&&t.showQrModal),qrModalOptions:f,projectId:t.projectId,metadata:t.metadata}}buildRpcMap(t,s){const i={};return t.forEach(e=>{i[e]=this.getRpcUrl(e,s)}),i}async initialize(t){if(this.rpc=this.getRpcConfig(t),this.chainId=this.rpc.chains.length?ethereum_provider_dist_index_es_v(this.rpc.chains):ethereum_provider_dist_index_es_v(this.rpc.optionalChains),this.signer=await index_es_es.init({projectId:this.rpc.projectId,metadata:this.rpc.metadata,disableProviderPing:t.disableProviderPing,relayUrl:t.relayUrl,storage:t.storage,storageOptions:t.storageOptions,customStoragePrefix:t.customStoragePrefix,telemetryEnabled:t.telemetryEnabled,logger:t.logger}),this.registerEventListeners(),await this.loadPersistedSession(),this.rpc.showQrModal){let s;try{const{WalletConnectModal:i}=await __webpack_require__.e(/* import() */ 940).then(__webpack_require__.bind(__webpack_require__, 80940));s=i}catch{throw new Error("To use QR modal, please install @walletconnect/modal package")}if(s)try{this.modal=new s(ethereum_provider_dist_index_es_g({projectId:this.rpc.projectId},this.rpc.qrModalOptions))}catch(i){throw this.signer.logger.error(i),new Error("Could not generate WalletConnectModal Instance")}}}loadConnectOpts(t){if(!t)return;const{chains:s,optionalChains:i,rpcMap:e}=t;s&&index_es_$e(s)&&(this.rpc.chains=s.map(n=>this.formatChainId(n)),s.forEach(n=>{this.rpc.rpcMap[n]=e?.[n]||this.getRpcUrl(n)})),i&&index_es_$e(i)&&(this.rpc.optionalChains=[],this.rpc.optionalChains=i?.map(n=>this.formatChainId(n)),i.forEach(n=>{this.rpc.rpcMap[n]=e?.[n]||this.getRpcUrl(n)}))}getRpcUrl(t,s){var i;return((i=this.rpc.rpcMap)==null?void 0:i[t])||`${dist_index_es_q}?chainId=eip155:${t}&projectId=${s||this.rpc.projectId}`}async loadPersistedSession(){if(this.session)try{const t=await this.signer.client.core.storage.getItem(`${this.STORAGE_KEY}/chainId`),s=this.session.namespaces[`${this.namespace}:${t}`]?this.session.namespaces[`${this.namespace}:${t}`]:this.session.namespaces[this.namespace];this.setChainIds(t?[this.formatChainId(t)]:s?.accounts),this.setAccounts(s?.accounts)}catch(t){this.signer.logger.error("Failed to load persisted session, clearing state..."),this.signer.logger.error(t),await this.disconnect().catch(s=>this.signer.logger.warn(s))}}reset(){this.chainId=1,this.accounts=[]}persist(){this.session&&this.signer.client.core.storage.setItem(`${this.STORAGE_KEY}/chainId`,this.chainId)}parseAccounts(t){return typeof t=="string"||t instanceof String?[this.parseAccount(t)]:t.map(s=>this.parseAccount(s))}}const ethereum_provider_dist_index_es_z=(/* unused pure expression or super */ null && (ethereum_provider_dist_index_es_w));
//# sourceMappingURL=index.es.js.map


/***/ }),

/***/ 86754:
/***/ ((module) => {



module.exports = state

function state (o) {
  const {
    secret,
    censor,
    compileRestore,
    serialize,
    groupRedact,
    nestedRedact,
    wildcards,
    wcLen
  } = o
  const builder = [{ secret, censor, compileRestore }]
  if (serialize !== false) builder.push({ serialize })
  if (wcLen > 0) builder.push({ groupRedact, nestedRedact, wildcards, wcLen })
  return Object.assign(...builder)
}


/***/ }),

/***/ 88900:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const tslib_1 = __webpack_require__(80584);
tslib_1.__exportStar(__webpack_require__(99606), exports);
tslib_1.__exportStar(__webpack_require__(89883), exports);
tslib_1.__exportStar(__webpack_require__(39629), exports);
tslib_1.__exportStar(__webpack_require__(49026), exports);
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 89883:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Watch = void 0;
class Watch {
    constructor() {
        this.timestamps = new Map();
    }
    start(label) {
        if (this.timestamps.has(label)) {
            throw new Error(`Watch already started for label: ${label}`);
        }
        this.timestamps.set(label, { started: Date.now() });
    }
    stop(label) {
        const timestamp = this.get(label);
        if (typeof timestamp.elapsed !== "undefined") {
            throw new Error(`Watch already stopped for label: ${label}`);
        }
        const elapsed = Date.now() - timestamp.started;
        this.timestamps.set(label, { started: timestamp.started, elapsed });
    }
    get(label) {
        const timestamp = this.timestamps.get(label);
        if (typeof timestamp === "undefined") {
            throw new Error(`No timestamp found for label: ${label}`);
        }
        return timestamp;
    }
    elapsed(label) {
        const timestamp = this.get(label);
        const elapsed = timestamp.elapsed || Date.now() - timestamp.started;
        return elapsed;
    }
}
exports.Watch = Watch;
exports["default"] = Watch;
//# sourceMappingURL=watch.js.map

/***/ }),

/***/ 91089:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isBrowser = exports.isNode = exports.isReactNative = void 0;
function isReactNative() {
    return (typeof document === "undefined" &&
        typeof navigator !== "undefined" &&
        navigator.product === "ReactNative");
}
exports.isReactNative = isReactNative;
function isNode() {
    return (typeof process !== "undefined" &&
        typeof process.versions !== "undefined" &&
        typeof process.versions.node !== "undefined");
}
exports.isNode = isNode;
function isBrowser() {
    return !isReactNative() && !isNode();
}
exports.isBrowser = isBrowser;
//# sourceMappingURL=env.js.map

/***/ }),

/***/ 92784:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const WebSocket = __webpack_require__(315);

WebSocket.createWebSocketStream = __webpack_require__(74722);
WebSocket.Server = __webpack_require__(10463);
WebSocket.Receiver = __webpack_require__(79195);
WebSocket.Sender = __webpack_require__(82055);

module.exports = WebSocket;


/***/ }),

/***/ 94308:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


/* eslint no-prototype-builtins: 0 */
const os = __webpack_require__(70857)
const stdSerializers = __webpack_require__(37214)
const caller = __webpack_require__(54811)
const redaction = __webpack_require__(4123)
const time = __webpack_require__(98329)
const proto = __webpack_require__(70824)
const symbols = __webpack_require__(65835)
const { configure } = __webpack_require__(12068)
const { assertDefaultLevelFound, mappings, genLsCache, levels } = __webpack_require__(95787)
const {
  createArgsNormalizer,
  asChindings,
  final,
  buildSafeSonicBoom,
  buildFormatters,
  stringify,
  normalizeDestFileDescriptor,
  noop
} = __webpack_require__(16761)
const { version } = __webpack_require__(66853)
const {
  chindingsSym,
  redactFmtSym,
  serializersSym,
  timeSym,
  timeSliceIndexSym,
  streamSym,
  stringifySym,
  stringifySafeSym,
  stringifiersSym,
  setLevelSym,
  endSym,
  formatOptsSym,
  messageKeySym,
  nestedKeySym,
  mixinSym,
  useOnlyCustomLevelsSym,
  formattersSym,
  hooksSym,
  nestedKeyStrSym,
  mixinMergeStrategySym
} = symbols
const { epochTime, nullTime } = time
const { pid } = process
const hostname = os.hostname()
const defaultErrorSerializer = stdSerializers.err
const defaultOptions = {
  level: 'info',
  levels,
  messageKey: 'msg',
  nestedKey: null,
  enabled: true,
  prettyPrint: false,
  base: { pid, hostname },
  serializers: Object.assign(Object.create(null), {
    err: defaultErrorSerializer
  }),
  formatters: Object.assign(Object.create(null), {
    bindings (bindings) {
      return bindings
    },
    level (label, number) {
      return { level: number }
    }
  }),
  hooks: {
    logMethod: undefined
  },
  timestamp: epochTime,
  name: undefined,
  redact: null,
  customLevels: null,
  useOnlyCustomLevels: false,
  depthLimit: 5,
  edgeLimit: 100
}

const normalize = createArgsNormalizer(defaultOptions)

const serializers = Object.assign(Object.create(null), stdSerializers)

function pino (...args) {
  const instance = {}
  const { opts, stream } = normalize(instance, caller(), ...args)
  const {
    redact,
    crlf,
    serializers,
    timestamp,
    messageKey,
    nestedKey,
    base,
    name,
    level,
    customLevels,
    mixin,
    mixinMergeStrategy,
    useOnlyCustomLevels,
    formatters,
    hooks,
    depthLimit,
    edgeLimit
  } = opts

  const stringifySafe = configure({
    maximumDepth: depthLimit,
    maximumBreadth: edgeLimit
  })

  const allFormatters = buildFormatters(
    formatters.level,
    formatters.bindings,
    formatters.log
  )

  const stringifiers = redact ? redaction(redact, stringify) : {}
  const stringifyFn = stringify.bind({
    [stringifySafeSym]: stringifySafe
  })
  const formatOpts = redact
    ? { stringify: stringifiers[redactFmtSym] }
    : { stringify: stringifyFn }
  const end = '}' + (crlf ? '\r\n' : '\n')
  const coreChindings = asChindings.bind(null, {
    [chindingsSym]: '',
    [serializersSym]: serializers,
    [stringifiersSym]: stringifiers,
    [stringifySym]: stringify,
    [stringifySafeSym]: stringifySafe,
    [formattersSym]: allFormatters
  })

  let chindings = ''
  if (base !== null) {
    if (name === undefined) {
      chindings = coreChindings(base)
    } else {
      chindings = coreChindings(Object.assign({}, base, { name }))
    }
  }

  const time = (timestamp instanceof Function)
    ? timestamp
    : (timestamp ? epochTime : nullTime)
  const timeSliceIndex = time().indexOf(':') + 1

  if (useOnlyCustomLevels && !customLevels) throw Error('customLevels is required if useOnlyCustomLevels is set true')
  if (mixin && typeof mixin !== 'function') throw Error(`Unknown mixin type "${typeof mixin}" - expected "function"`)

  assertDefaultLevelFound(level, customLevels, useOnlyCustomLevels)
  const levels = mappings(customLevels, useOnlyCustomLevels)

  Object.assign(instance, {
    levels,
    [useOnlyCustomLevelsSym]: useOnlyCustomLevels,
    [streamSym]: stream,
    [timeSym]: time,
    [timeSliceIndexSym]: timeSliceIndex,
    [stringifySym]: stringify,
    [stringifySafeSym]: stringifySafe,
    [stringifiersSym]: stringifiers,
    [endSym]: end,
    [formatOptsSym]: formatOpts,
    [messageKeySym]: messageKey,
    [nestedKeySym]: nestedKey,
    // protect against injection
    [nestedKeyStrSym]: nestedKey ? `,${JSON.stringify(nestedKey)}:{` : '',
    [serializersSym]: serializers,
    [mixinSym]: mixin,
    [mixinMergeStrategySym]: mixinMergeStrategy,
    [chindingsSym]: chindings,
    [formattersSym]: allFormatters,
    [hooksSym]: hooks,
    silent: noop
  })

  Object.setPrototypeOf(instance, proto())

  genLsCache(instance)

  instance[setLevelSym](level)

  return instance
}

module.exports = pino

module.exports.destination = (dest = process.stdout.fd) => {
  if (typeof dest === 'object') {
    dest.dest = normalizeDestFileDescriptor(dest.dest || process.stdout.fd)
    return buildSafeSonicBoom(dest)
  } else {
    return buildSafeSonicBoom({ dest: normalizeDestFileDescriptor(dest), minLength: 0, sync: true })
  }
}

module.exports.transport = __webpack_require__(82563)
module.exports.multistream = __webpack_require__(40351)

module.exports.final = final
module.exports.levels = mappings()
module.exports.stdSerializers = serializers
module.exports.stdTimeFunctions = Object.assign({}, time)
module.exports.symbols = symbols
module.exports.version = version

// Enables default and name export with TypeScript and Babel
module.exports["default"] = pino
module.exports.pino = pino


/***/ }),

/***/ 95787:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


/* eslint no-prototype-builtins: 0 */
const {
  lsCacheSym,
  levelValSym,
  useOnlyCustomLevelsSym,
  streamSym,
  formattersSym,
  hooksSym
} = __webpack_require__(65835)
const { noop, genLog } = __webpack_require__(16761)

const levels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
}
const levelMethods = {
  fatal: (hook) => {
    const logFatal = genLog(levels.fatal, hook)
    return function (...args) {
      const stream = this[streamSym]
      logFatal.call(this, ...args)
      if (typeof stream.flushSync === 'function') {
        try {
          stream.flushSync()
        } catch (e) {
          // https://github.com/pinojs/pino/pull/740#discussion_r346788313
        }
      }
    }
  },
  error: (hook) => genLog(levels.error, hook),
  warn: (hook) => genLog(levels.warn, hook),
  info: (hook) => genLog(levels.info, hook),
  debug: (hook) => genLog(levels.debug, hook),
  trace: (hook) => genLog(levels.trace, hook)
}

const nums = Object.keys(levels).reduce((o, k) => {
  o[levels[k]] = k
  return o
}, {})

const initialLsCache = Object.keys(nums).reduce((o, k) => {
  o[k] = '{"level":' + Number(k)
  return o
}, {})

function genLsCache (instance) {
  const formatter = instance[formattersSym].level
  const { labels } = instance.levels
  const cache = {}
  for (const label in labels) {
    const level = formatter(labels[label], Number(label))
    cache[label] = JSON.stringify(level).slice(0, -1)
  }
  instance[lsCacheSym] = cache
  return instance
}

function isStandardLevel (level, useOnlyCustomLevels) {
  if (useOnlyCustomLevels) {
    return false
  }

  switch (level) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
      return true
    default:
      return false
  }
}

function setLevel (level) {
  const { labels, values } = this.levels
  if (typeof level === 'number') {
    if (labels[level] === undefined) throw Error('unknown level value' + level)
    level = labels[level]
  }
  if (values[level] === undefined) throw Error('unknown level ' + level)
  const preLevelVal = this[levelValSym]
  const levelVal = this[levelValSym] = values[level]
  const useOnlyCustomLevelsVal = this[useOnlyCustomLevelsSym]
  const hook = this[hooksSym].logMethod

  for (const key in values) {
    if (levelVal > values[key]) {
      this[key] = noop
      continue
    }
    this[key] = isStandardLevel(key, useOnlyCustomLevelsVal) ? levelMethods[key](hook) : genLog(values[key], hook)
  }

  this.emit(
    'level-change',
    level,
    levelVal,
    labels[preLevelVal],
    preLevelVal
  )
}

function getLevel (level) {
  const { levels, levelVal } = this
  // protection against potential loss of Pino scope from serializers (edge case with circular refs - https://github.com/pinojs/pino/issues/833)
  return (levels && levels.labels) ? levels.labels[levelVal] : ''
}

function isLevelEnabled (logLevel) {
  const { values } = this.levels
  const logLevelVal = values[logLevel]
  return logLevelVal !== undefined && (logLevelVal >= this[levelValSym])
}

function mappings (customLevels = null, useOnlyCustomLevels = false) {
  const customNums = customLevels
    /* eslint-disable */
    ? Object.keys(customLevels).reduce((o, k) => {
        o[customLevels[k]] = k
        return o
      }, {})
    : null
    /* eslint-enable */

  const labels = Object.assign(
    Object.create(Object.prototype, { Infinity: { value: 'silent' } }),
    useOnlyCustomLevels ? null : nums,
    customNums
  )
  const values = Object.assign(
    Object.create(Object.prototype, { silent: { value: Infinity } }),
    useOnlyCustomLevels ? null : levels,
    customLevels
  )
  return { labels, values }
}

function assertDefaultLevelFound (defaultLevel, customLevels, useOnlyCustomLevels) {
  if (typeof defaultLevel === 'number') {
    const values = [].concat(
      Object.keys(customLevels || {}).map(key => customLevels[key]),
      useOnlyCustomLevels ? [] : Object.keys(nums).map(level => +level),
      Infinity
    )
    if (!values.includes(defaultLevel)) {
      throw Error(`default level:${defaultLevel} must be included in custom levels`)
    }
    return
  }

  const labels = Object.assign(
    Object.create(Object.prototype, { silent: { value: Infinity } }),
    useOnlyCustomLevels ? null : levels,
    customLevels
  )
  if (!(defaultLevel in labels)) {
    throw Error(`default level:${defaultLevel} must be included in custom levels`)
  }
}

function assertNoLevelCollisions (levels, customLevels) {
  const { labels, values } = levels
  for (const k in customLevels) {
    if (k in values) {
      throw Error('levels cannot be overridden')
    }
    if (customLevels[k] in labels) {
      throw Error('pre-existing level values cannot be used for new levels')
    }
  }
}

module.exports = {
  initialLsCache,
  genLsCache,
  levelMethods,
  getLevel,
  setLevel,
  isLevelEnabled,
  mappings,
  levels,
  assertNoLevelCollisions,
  assertDefaultLevelFound
}


/***/ }),

/***/ 96596:
/***/ ((module) => {



const kDone = Symbol('kDone');
const kRun = Symbol('kRun');

/**
 * A very simple job queue with adjustable concurrency. Adapted from
 * https://github.com/STRML/async-limiter
 */
class Limiter {
  /**
   * Creates a new `Limiter`.
   *
   * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
   *     to run concurrently
   */
  constructor(concurrency) {
    this[kDone] = () => {
      this.pending--;
      this[kRun]();
    };
    this.concurrency = concurrency || Infinity;
    this.jobs = [];
    this.pending = 0;
  }

  /**
   * Adds a job to the queue.
   *
   * @param {Function} job The job to run
   * @public
   */
  add(job) {
    this.jobs.push(job);
    this[kRun]();
  }

  /**
   * Removes a job from the queue and runs it if possible.
   *
   * @private
   */
  [kRun]() {
    if (this.pending === this.concurrency) return;

    if (this.jobs.length) {
      const job = this.jobs.shift();

      this.pending++;
      job(this[kDone]);
    }
  }
}

module.exports = Limiter;


/***/ }),

/***/ 97157:
/***/ ((module) => {



module.exports = {
  groupRedact,
  groupRestore,
  nestedRedact,
  nestedRestore
}

function groupRestore ({ keys, values, target }) {
  if (target == null || typeof target === 'string') return
  const length = keys.length
  for (var i = 0; i < length; i++) {
    const k = keys[i]
    target[k] = values[i]
  }
}

function groupRedact (o, path, censor, isCensorFct, censorFctTakesPath) {
  const target = get(o, path)
  if (target == null || typeof target === 'string') return { keys: null, values: null, target, flat: true }
  const keys = Object.keys(target)
  const keysLength = keys.length
  const pathLength = path.length
  const pathWithKey = censorFctTakesPath ? [...path] : undefined
  const values = new Array(keysLength)

  for (var i = 0; i < keysLength; i++) {
    const key = keys[i]
    values[i] = target[key]

    if (censorFctTakesPath) {
      pathWithKey[pathLength] = key
      target[key] = censor(target[key], pathWithKey)
    } else if (isCensorFct) {
      target[key] = censor(target[key])
    } else {
      target[key] = censor
    }
  }
  return { keys, values, target, flat: true }
}

/**
 * @param {RestoreInstruction[]} instructions a set of instructions for restoring values to objects
 */
function nestedRestore (instructions) {
  for (let i = 0; i < instructions.length; i++) {
    const { target, path, value } = instructions[i]
    let current = target
    for (let i = path.length - 1; i > 0; i--) {
      current = current[path[i]]
    }
    current[path[0]] = value
  }
}

function nestedRedact (store, o, path, ns, censor, isCensorFct, censorFctTakesPath) {
  const target = get(o, path)
  if (target == null) return
  const keys = Object.keys(target)
  const keysLength = keys.length
  for (var i = 0; i < keysLength; i++) {
    const key = keys[i]
    specialSet(store, target, key, path, ns, censor, isCensorFct, censorFctTakesPath)
  }
  return store
}

function has (obj, prop) {
  return obj !== undefined && obj !== null
    ? ('hasOwn' in Object ? Object.hasOwn(obj, prop) : Object.prototype.hasOwnProperty.call(obj, prop))
    : false
}

function specialSet (store, o, k, path, afterPath, censor, isCensorFct, censorFctTakesPath) {
  const afterPathLen = afterPath.length
  const lastPathIndex = afterPathLen - 1
  const originalKey = k
  var i = -1
  var n
  var nv
  var ov
  var oov = null
  var wc = null
  var kIsWc
  var wcov
  var consecutive = false
  var level = 0
  // need to track depth of the `redactPath` tree
  var depth = 0
  var redactPathCurrent = tree()
  ov = n = o[k]
  if (typeof n !== 'object') return
  while (n != null && ++i < afterPathLen) {
    depth += 1
    k = afterPath[i]
    oov = ov
    if (k !== '*' && !wc && !(typeof n === 'object' && k in n)) {
      break
    }
    if (k === '*') {
      if (wc === '*') {
        consecutive = true
      }
      wc = k
      if (i !== lastPathIndex) {
        continue
      }
    }
    if (wc) {
      const wcKeys = Object.keys(n)
      for (var j = 0; j < wcKeys.length; j++) {
        const wck = wcKeys[j]
        wcov = n[wck]
        kIsWc = k === '*'
        if (consecutive) {
          redactPathCurrent = node(redactPathCurrent, wck, depth)
          level = i
          ov = iterateNthLevel(wcov, level - 1, k, path, afterPath, censor, isCensorFct, censorFctTakesPath, originalKey, n, nv, ov, kIsWc, wck, i, lastPathIndex, redactPathCurrent, store, o[originalKey], depth + 1)
        } else {
          if (kIsWc || (typeof wcov === 'object' && wcov !== null && k in wcov)) {
            if (kIsWc) {
              ov = wcov
            } else {
              ov = wcov[k]
            }
            nv = (i !== lastPathIndex)
              ? ov
              : (isCensorFct
                ? (censorFctTakesPath ? censor(ov, [...path, originalKey, ...afterPath]) : censor(ov))
                : censor)
            if (kIsWc) {
              const rv = restoreInstr(node(redactPathCurrent, wck, depth), ov, o[originalKey])
              store.push(rv)
              n[wck] = nv
            } else {
              if (wcov[k] === nv) {
                // pass
              } else if ((nv === undefined && censor !== undefined) || (has(wcov, k) && nv === ov)) {
                redactPathCurrent = node(redactPathCurrent, wck, depth)
              } else {
                redactPathCurrent = node(redactPathCurrent, wck, depth)
                const rv = restoreInstr(node(redactPathCurrent, k, depth + 1), ov, o[originalKey])
                store.push(rv)
                wcov[k] = nv
              }
            }
          }
        }
      }
      wc = null
    } else {
      ov = n[k]
      redactPathCurrent = node(redactPathCurrent, k, depth)
      nv = (i !== lastPathIndex)
        ? ov
        : (isCensorFct
          ? (censorFctTakesPath ? censor(ov, [...path, originalKey, ...afterPath]) : censor(ov))
          : censor)
      if ((has(n, k) && nv === ov) || (nv === undefined && censor !== undefined)) {
        // pass
      } else {
        const rv = restoreInstr(redactPathCurrent, ov, o[originalKey])
        store.push(rv)
        n[k] = nv
      }
      n = n[k]
    }
    if (typeof n !== 'object') break
    // prevent circular structure, see https://github.com/pinojs/pino/issues/1513
    if (ov === oov || typeof ov === 'undefined') {
      // pass
    }
  }
}

function get (o, p) {
  var i = -1
  var l = p.length
  var n = o
  while (n != null && ++i < l) {
    n = n[p[i]]
  }
  return n
}

function iterateNthLevel (wcov, level, k, path, afterPath, censor, isCensorFct, censorFctTakesPath, originalKey, n, nv, ov, kIsWc, wck, i, lastPathIndex, redactPathCurrent, store, parent, depth) {
  if (level === 0) {
    if (kIsWc || (typeof wcov === 'object' && wcov !== null && k in wcov)) {
      if (kIsWc) {
        ov = wcov
      } else {
        ov = wcov[k]
      }
      nv = (i !== lastPathIndex)
        ? ov
        : (isCensorFct
          ? (censorFctTakesPath ? censor(ov, [...path, originalKey, ...afterPath]) : censor(ov))
          : censor)
      if (kIsWc) {
        const rv = restoreInstr(redactPathCurrent, ov, parent)
        store.push(rv)
        n[wck] = nv
      } else {
        if (wcov[k] === nv) {
          // pass
        } else if ((nv === undefined && censor !== undefined) || (has(wcov, k) && nv === ov)) {
          // pass
        } else {
          const rv = restoreInstr(node(redactPathCurrent, k, depth + 1), ov, parent)
          store.push(rv)
          wcov[k] = nv
        }
      }
    }
  }
  for (const key in wcov) {
    if (typeof wcov[key] === 'object') {
      redactPathCurrent = node(redactPathCurrent, key, depth)
      iterateNthLevel(wcov[key], level - 1, k, path, afterPath, censor, isCensorFct, censorFctTakesPath, originalKey, n, nv, ov, kIsWc, wck, i, lastPathIndex, redactPathCurrent, store, parent, depth + 1)
    }
  }
}

/**
 * @typedef {object} TreeNode
 * @prop {TreeNode} [parent] reference to the parent of this node in the tree, or `null` if there is no parent
 * @prop {string} key the key that this node represents (key here being part of the path being redacted
 * @prop {TreeNode[]} children the child nodes of this node
 * @prop {number} depth the depth of this node in the tree
 */

/**
 * instantiate a new, empty tree
 * @returns {TreeNode}
 */
function tree () {
  return { parent: null, key: null, children: [], depth: 0 }
}

/**
 * creates a new node in the tree, attaching it as a child of the provided parent node
 * if the specified depth matches the parent depth, adds the new node as a _sibling_ of the parent instead
  * @param {TreeNode} parent the parent node to add a new node to (if the parent depth matches the provided `depth` value, will instead add as a sibling of this
  * @param {string} key the key that the new node represents (key here being part of the path being redacted)
  * @param {number} depth the depth of the new node in the tree - used to determing whether to add the new node as a child or sibling of the provided `parent` node
  * @returns {TreeNode} a reference to the newly created node in the tree
 */
function node (parent, key, depth) {
  if (parent.depth === depth) {
    return node(parent.parent, key, depth)
  }

  var child = {
    parent,
    key,
    depth,
    children: []
  }

  parent.children.push(child)

  return child
}

/**
 * @typedef {object} RestoreInstruction
 * @prop {string[]} path a reverse-order path that can be used to find the correct insertion point to restore a `value` for the given `parent` object
 * @prop {*} value the value to restore
 * @prop {object} target the object to restore the `value` in
 */

/**
 * create a restore instruction for the given redactPath node
 * generates a path in reverse order by walking up the redactPath tree
 * @param {TreeNode} node a tree node that should be at the bottom of the redact path (i.e. have no children) - this will be used to walk up the redact path tree to construct the path needed to restore
 * @param {*} value the value to restore
 * @param {object} target a reference to the parent object to apply the restore instruction to
 * @returns {RestoreInstruction} an instruction used to restore a nested value for a specific object
 */
function restoreInstr (node, value, target) {
  let current = node
  const path = []
  do {
    path.push(current.key)
    current = current.parent
  } while (current.parent != null)

  return { path, value, target }
}


/***/ }),

/***/ 98186:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   __assign: () => (/* binding */ __assign),
/* harmony export */   __asyncDelegator: () => (/* binding */ __asyncDelegator),
/* harmony export */   __asyncGenerator: () => (/* binding */ __asyncGenerator),
/* harmony export */   __asyncValues: () => (/* binding */ __asyncValues),
/* harmony export */   __await: () => (/* binding */ __await),
/* harmony export */   __awaiter: () => (/* binding */ __awaiter),
/* harmony export */   __classPrivateFieldGet: () => (/* binding */ __classPrivateFieldGet),
/* harmony export */   __classPrivateFieldSet: () => (/* binding */ __classPrivateFieldSet),
/* harmony export */   __createBinding: () => (/* binding */ __createBinding),
/* harmony export */   __decorate: () => (/* binding */ __decorate),
/* harmony export */   __exportStar: () => (/* binding */ __exportStar),
/* harmony export */   __extends: () => (/* binding */ __extends),
/* harmony export */   __generator: () => (/* binding */ __generator),
/* harmony export */   __importDefault: () => (/* binding */ __importDefault),
/* harmony export */   __importStar: () => (/* binding */ __importStar),
/* harmony export */   __makeTemplateObject: () => (/* binding */ __makeTemplateObject),
/* harmony export */   __metadata: () => (/* binding */ __metadata),
/* harmony export */   __param: () => (/* binding */ __param),
/* harmony export */   __read: () => (/* binding */ __read),
/* harmony export */   __rest: () => (/* binding */ __rest),
/* harmony export */   __spread: () => (/* binding */ __spread),
/* harmony export */   __spreadArrays: () => (/* binding */ __spreadArrays),
/* harmony export */   __values: () => (/* binding */ __values)
/* harmony export */ });
/*! *****************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise */

var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return extendStatics(d, b);
};

function __extends(d, b) {
    extendStatics(d, b);
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

var __assign = function() {
    __assign = Object.assign || function __assign(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
    }
    return __assign.apply(this, arguments);
}

function __rest(s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
}

function __decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}

function __param(paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
}

function __metadata(metadataKey, metadataValue) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}

function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

function __generator(thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
}

function __createBinding(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}

function __exportStar(m, exports) {
    for (var p in m) if (p !== "default" && !exports.hasOwnProperty(p)) exports[p] = m[p];
}

function __values(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

function __read(o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
}

function __spread() {
    for (var ar = [], i = 0; i < arguments.length; i++)
        ar = ar.concat(__read(arguments[i]));
    return ar;
}

function __spreadArrays() {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};

function __await(v) {
    return this instanceof __await ? (this.v = v, this) : new __await(v);
}

function __asyncGenerator(thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
    function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
}

function __asyncDelegator(o) {
    var i, p;
    return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
    function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: n === "return" } : f ? f(v) : v; } : f; }
}

function __asyncValues(o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
}

function __makeTemplateObject(cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
};

function __importStar(mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result.default = mod;
    return result;
}

function __importDefault(mod) {
    return (mod && mod.__esModule) ? mod : { default: mod };
}

function __classPrivateFieldGet(receiver, privateMap) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to get private field on non-instance");
    }
    return privateMap.get(receiver);
}

function __classPrivateFieldSet(receiver, privateMap, value) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to set private field on non-instance");
    }
    privateMap.set(receiver, value);
    return value;
}


/***/ }),

/***/ 98329:
/***/ ((module) => {



const nullTime = () => ''

const epochTime = () => `,"time":${Date.now()}`

const unixTime = () => `,"time":${Math.round(Date.now() / 1000.0)}`

const isoTime = () => `,"time":"${new Date(Date.now()).toISOString()}"` // using Date.now() for testability

module.exports = { nullTime, epochTime, unixTime, isoTime }


/***/ }),

/***/ 99405:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



const { EMPTY_BUFFER } = __webpack_require__(43713);

/**
 * Merges an array of buffers into a new buffer.
 *
 * @param {Buffer[]} list The array of buffers to concat
 * @param {Number} totalLength The total length of buffers in the list
 * @return {Buffer} The resulting buffer
 * @public
 */
function concat(list, totalLength) {
  if (list.length === 0) return EMPTY_BUFFER;
  if (list.length === 1) return list[0];

  const target = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    target.set(buf, offset);
    offset += buf.length;
  }

  if (offset < totalLength) return target.slice(0, offset);

  return target;
}

/**
 * Masks a buffer using the given mask.
 *
 * @param {Buffer} source The buffer to mask
 * @param {Buffer} mask The mask to use
 * @param {Buffer} output The buffer where to store the result
 * @param {Number} offset The offset at which to start writing
 * @param {Number} length The number of bytes to mask.
 * @public
 */
function _mask(source, mask, output, offset, length) {
  for (let i = 0; i < length; i++) {
    output[offset + i] = source[i] ^ mask[i & 3];
  }
}

/**
 * Unmasks a buffer using the given mask.
 *
 * @param {Buffer} buffer The buffer to unmask
 * @param {Buffer} mask The mask to use
 * @public
 */
function _unmask(buffer, mask) {
  // Required until https://github.com/nodejs/node/issues/9006 is resolved.
  const length = buffer.length;
  for (let i = 0; i < length; i++) {
    buffer[i] ^= mask[i & 3];
  }
}

/**
 * Converts a buffer to an `ArrayBuffer`.
 *
 * @param {Buffer} buf The buffer to convert
 * @return {ArrayBuffer} Converted buffer
 * @public
 */
function toArrayBuffer(buf) {
  if (buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer;
  }

  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Converts `data` to a `Buffer`.
 *
 * @param {*} data The data to convert
 * @return {Buffer} The buffer
 * @throws {TypeError}
 * @public
 */
function toBuffer(data) {
  toBuffer.readOnly = true;

  if (Buffer.isBuffer(data)) return data;

  let buf;

  if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data);
  } else if (ArrayBuffer.isView(data)) {
    buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else {
    buf = Buffer.from(data);
    toBuffer.readOnly = false;
  }

  return buf;
}

try {
  const bufferUtil = __webpack_require__(Object(function webpackMissingModule() { var e = new Error("Cannot find module 'bufferutil'"); e.code = 'MODULE_NOT_FOUND'; throw e; }()));
  const bu = bufferUtil.BufferUtil || bufferUtil;

  module.exports = {
    concat,
    mask(source, mask, output, offset, length) {
      if (length < 48) _mask(source, mask, output, offset, length);
      else bu.mask(source, mask, output, offset, length);
    },
    toArrayBuffer,
    toBuffer,
    unmask(buffer, mask) {
      if (buffer.length < 32) _unmask(buffer, mask);
      else bu.unmask(buffer, mask);
    }
  };
} catch (e) /* istanbul ignore next */ {
  module.exports = {
    concat,
    mask: _mask,
    toArrayBuffer,
    toBuffer,
    unmask: _unmask
  };
}


/***/ }),

/***/ 99606:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const tslib_1 = __webpack_require__(80584);
tslib_1.__exportStar(__webpack_require__(2985), exports);
tslib_1.__exportStar(__webpack_require__(60221), exports);
//# sourceMappingURL=index.js.map

/***/ })

};
;