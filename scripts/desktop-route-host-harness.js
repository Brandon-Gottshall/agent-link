import WebSocket from "ws";

export class DesktopRouteHost {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.options = {
      autoRespond: false,
      ...options
    };
    this.nextId = 1;
    this.pending = new Map();
    this.requests = [];
    this.requestWaiters = [];
    this.selectedThreadId = null;
    this.handledRequests = [];
    ws.on("message", (raw) => this.handleMessage(raw));
  }

  static async connect(url, options = {}) {
    const ws = new WebSocket(url);
    await waitForOpen(ws);
    const host = new DesktopRouteHost(ws, options);
    await host.initialize();
    return host;
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "desktop-client",
        title: "Codex Desktop Route Harness",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.ws.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  async request(method, params) {
    const id = `desktop-host-${this.nextId++}`;
    const payload = { id, method, params };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify(payload), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  nextRequest() {
    if (this.requests.length > 0) {
      return Promise.resolve(this.requests.shift());
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requestWaiters = this.requestWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error("Timed out waiting for desktop host server request"));
      }, 30000);
      this.requestWaiters.push({ resolve, timeout });
    });
  }

  respond(id, result) {
    this.ws.send(JSON.stringify({ id, result }));
  }

  handleMessage(raw) {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      if (this.options.autoRespond && this.handleAutoRequest(message)) {
        return;
      }
      if (this.requestWaiters.length > 0) {
        const waiter = this.requestWaiters.shift();
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        this.requests.push(message);
      }
    }
  }

  handleAutoRequest(message) {
    if (message.method === "desktop/thread/route/request") {
      const threadId = message.params?.threadId;
      const focus = message.params?.focus ?? false;
      if (!threadId) {
        return false;
      }
      this.selectedThreadId = threadId;
      this.handledRequests.push({
        method: message.method,
        threadId,
        focus
      });
      this.respond(message.id, {
        threadId,
        focus,
        routed: true,
        authority: "nativeQuietRoute",
        selection: {
          threadId,
          focused: Boolean(focus)
        },
        reason: null
      });
      return true;
    }

    if (message.method === "desktop/thread/selection/read/request") {
      this.handledRequests.push({
        method: message.method,
        threadId: this.selectedThreadId,
        focus: false
      });
      this.respond(message.id, {
        selection: this.selectedThreadId
          ? {
              threadId: this.selectedThreadId,
              focused: false
            }
          : null,
        authority: this.selectedThreadId ? "nativeQuietRoute" : "unsupported",
        reason: this.selectedThreadId ? null : "desktop route harness has no selected thread"
      });
      return true;
    }

    return false;
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }
}

async function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening desktop host websocket"));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}
