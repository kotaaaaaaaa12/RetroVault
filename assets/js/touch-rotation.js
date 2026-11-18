"use strict";

(() => {
  const TOUCH_LIST_KEYS = new Set(["touches", "targetTouches", "changedTouches"]);
  const COORDINATE_KEYS = new Set(["clientX", "clientY", "pageX", "pageY", "screenX", "screenY"]);
  const TOUCH_EVENTS = new Set(["touchstart", "touchmove", "touchend", "touchcancel"]);
  const MOUSE_EVENTS = new Set(["mousedown", "mouseup", "mousemove"]);

  function normalizeRotation(rotation) {
    return ((Number(rotation) % 4) + 4) % 4;
  }

  function contentRect(rect, aspectRatio) {
    if (!rect) return rect;
    const width = Number(rect.width);
    const height = Number(rect.height);
    const aspect = Number(aspectRatio);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return rect;
    if (!Number.isFinite(aspect) || aspect <= 0) return rect;
    if (Math.abs(width / height - aspect) < 0.0001) return rect;
    const contentWidth = width / height > aspect ? height * aspect : width;
    const contentHeight = width / height > aspect ? height : width / aspect;
    return {
      left: rect.left + (width - contentWidth) / 2,
      top: rect.top,
      width: contentWidth,
      height: contentHeight
    };
  }

  function rotatePoint(x, y, rect, rotation) {
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || !rect.width || !rect.height) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const u = (x - rect.left) / rect.width - 0.5;
    const v = (y - rect.top) / rect.height - 0.5;
    let nextU = u;
    let nextV = v;
    switch (normalizeRotation(rotation)) {
      case 1: nextU = -v; nextV = u; break;
      case 2: nextU = -u; nextV = -v; break;
      case 3: nextU = v; nextV = -u; break;
    }
    return {
      x: rect.left + (nextU + 0.5) * rect.width,
      y: rect.top + (nextV + 0.5) * rect.height
    };
  }

  function rotateTouchList(list, rect, rotation) {
    if (!list || typeof list.length !== "number") return list;
    const items = [];
    for (let index = 0; index < list.length; index++) {
      const touch = list[index];
      const point = touch ? rotatePoint(touch.clientX, touch.clientY, rect, rotation) : null;
      if (!touch || !point) {
        items.push(touch);
        continue;
      }
      const copy = {};
      for (const key of ["identifier", "radiusX", "radiusY", "rotationAngle", "force", "target"]) copy[key] = touch[key];
      copy.clientX = point.x;
      copy.clientY = point.y;
      copy.pageX = Number.isFinite(Number(touch.pageX)) ? point.x + Number(touch.pageX) - Number(touch.clientX) : point.x;
      copy.pageY = Number.isFinite(Number(touch.pageY)) ? point.y + Number(touch.pageY) - Number(touch.clientY) : point.y;
      copy.screenX = Number.isFinite(Number(touch.screenX)) ? point.x + Number(touch.screenX) - Number(touch.clientX) : point.x;
      copy.screenY = Number.isFinite(Number(touch.screenY)) ? point.y + Number(touch.screenY) - Number(touch.clientY) : point.y;
      items.push(copy);
    }
    Object.defineProperty(items, "item", {
      value(index) { return this[index] || null; }
    });
    return items;
  }

  function rotateEvent(event, rect, rotation) {
    return new Proxy(event, {
      get(target, property) {
        if (TOUCH_LIST_KEYS.has(property)) return rotateTouchList(Reflect.get(target, property, target), rect, rotation);
        if (COORDINATE_KEYS.has(property)) {
          const clientX = Reflect.get(target, "clientX", target);
          const clientY = Reflect.get(target, "clientY", target);
          const point = rotatePoint(clientX, clientY, rect, rotation);
          if (point) {
            if (property === "clientX") return point.x;
            if (property === "clientY") return point.y;
            const offset = property.startsWith("page") ? "client" : "screen";
            const original = Number(Reflect.get(target, property, target));
            const base = Number(Reflect.get(target, offset + (property.endsWith("X") ? "X" : "Y"), target));
            if (Number.isFinite(original) && Number.isFinite(base)) {
              return property.endsWith("X") ? point.x + original - base : point.y + original - base;
            }
          }
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      }
    });
  }

  class RetroTouchRotation {
    constructor(canvas, rotation, options = {}) {
      this.canvas = canvas;
      this.rotation = normalizeRotation(rotation);
      this.getAspectRatio = typeof options.getAspectRatio === "function" ? options.getAspectRatio : null;
      this.originalAdd = null;
      this.originalRemove = null;
      this.proxies = new WeakMap();
    }

    attach() {
      if (!this.canvas || !this.rotation || typeof this.canvas.addEventListener !== "function" || typeof this.canvas.removeEventListener !== "function") return false;
      if (this.originalAdd) return false;
      const canvas = this.canvas;
      const proxies = this.proxies;
      const originalAdd = canvas.addEventListener;
      const originalRemove = canvas.removeEventListener;
      const transform = event => {
        const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
        const requestedAspect = this.getAspectRatio ? this.getAspectRatio() : null;
        const intrinsicAspect = Number(canvas.width) > 0 && Number(canvas.height) > 0 ? Number(canvas.width) / Number(canvas.height) : null;
        return rotateEvent(event, contentRect(rect, requestedAspect || intrinsicAspect), this.rotation);
      };
      canvas.addEventListener = function(type, listener, options) {
        if (typeof listener === "function" && (TOUCH_EVENTS.has(type) || MOUSE_EVENTS.has(type))) {
          let proxy = proxies.get(listener);
          if (!proxy) {
            proxy = function(event) { return listener.call(this, transform(event)); };
            proxies.set(listener, proxy);
          }
          return originalAdd.call(this, type, proxy, options);
        }
        return originalAdd.call(this, type, listener, options);
      };
      canvas.removeEventListener = function(type, listener, options) {
        return originalRemove.call(this, type, proxies.get(listener) || listener, options);
      };
      this.originalAdd = originalAdd;
      this.originalRemove = originalRemove;
      return true;
    }

    detach() {
      if (!this.originalAdd) return false;
      this.canvas.addEventListener = this.originalAdd;
      this.canvas.removeEventListener = this.originalRemove;
      this.originalAdd = null;
      this.originalRemove = null;
      this.proxies = new WeakMap();
      return true;
    }
  }

  RetroTouchRotation.rotatePoint = rotatePoint;
  RetroTouchRotation.contentRect = contentRect;

  window.RetroTouchRotation = RetroTouchRotation;
})();
