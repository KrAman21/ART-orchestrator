/**
 * Deferred Promise Utility
 * 
 * Creates a promise that can be resolved/rejected from outside
 * Used for coordinating async operations where resolution happens
 * in a different context than creation
 */

export class DeferredPromise {
  constructor(timeoutMs = null) {
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    
    this.resolved = false;
    this.rejected = false;
    this.timeoutHandle = null;
    
    if (timeoutMs) {
      this.timeoutHandle = setTimeout(() => {
        if (!this.resolved && !this.rejected) {
          this.reject(new Error(`Promise timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }
  }
  
  resolve(value) {
    if (!this.resolved && !this.rejected) {
      this.resolved = true;
      this._cleanup();
      this._resolve(value);
    }
  }
  
  reject(reason) {
    if (!this.resolved && !this.rejected) {
      this.rejected = true;
      this._cleanup();
      this._reject(reason);
    }
  }
  
  _cleanup() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
  
  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }
  
  catch(onRejected) {
    return this.promise.catch(onRejected);
  }
  
  finally(onFinally) {
    return this.promise.finally(onFinally);
  }
}

export function createDeferred(timeoutMs = null) {
  return new DeferredPromise(timeoutMs);
}
