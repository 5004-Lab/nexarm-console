// A transport gap must not erase the last decoded image or present it as live forever.
export class FrameHealth {
  constructor(graceMs = 2000) {
    this.graceMs = graceMs;
    this.lastFrameAt = null;
  }

  received(now) { this.lastFrameAt = now; }

  check(state, now) {
    const hasFrame = this.lastFrameAt !== null;
    const offline = ['missing', 'disabled', 'permission', 'unsupported'].includes(state);
    const paused = hasFrame && (offline || now - this.lastFrameAt >= this.graceMs);
    return { hasFrame, paused, resetCursor: paused };
  }
}
