import { describe, expect, it } from 'vitest'
import { CallAdaptation } from './callAdaptation'
import { callVideoFramerate, callVideoSize } from './callQuality'

const feedback = (feedback_seq: number, video_seq: number, received_frames: number) =>
  ({ feedback_seq, video_seq, received_frames, received_bytes: 10000, interval_ms: 1000 })

describe('adaptive meeting video', () => {
  it('starts at 720p/30, backs off to delivered throughput, then recovers after stable feedback', () => {
    const a = new CallAdaptation(2_000_000, 0)
    expect(callVideoSize({}, { width: 1280, height: 720 }, a.target)).toEqual({ width: 1280, height: 720 })
    expect(callVideoFramerate({}, a.target)).toBe(30)
    a.feedback({ ...feedback(0, 29, 20), received_bytes: 50000 }, 1000)
    expect(a.target).toBe(340000)
    expect(callVideoSize({}, { width: 1280, height: 720 }, a.target)).toEqual({ width: 480, height: 270 })
    expect(callVideoFramerate({}, a.target)).toBe(15)
    for (let seq = 1; seq < 5; seq++) a.feedback(feedback(seq, 29 + seq * 30, 30), (seq + 1) * 1000)
    expect(a.target).toBe(340000)
    for (let seq = 5; seq < 40; seq++) a.feedback(feedback(seq, 29 + seq * 30, 30), (seq + 1) * 1000)
    expect(a.target).toBe(2000000)
    expect(callVideoSize({}, { width: 1280, height: 720 }, a.target)).toEqual({ width: 1280, height: 720 })
    a.tick(44000)
    expect(a.target).toBeLessThan(2000000)
  })
  it('backs off for complete video loss and holds steady for idle capture', () => {
    const a = new CallAdaptation(2000000, 0)
    for (let seq = 0; seq < 5; seq++) {
      a.sentFrame(seq)
      a.feedback({ ...feedback(seq, 0, 0), video_seq: undefined, received_bytes: 0 }, (seq + 1) * 1000)
    }
    expect(a.target).toBe(100000)
    a.feedback({ ...feedback(5, 0, 0), video_seq: undefined, received_bytes: 0 }, 6000)
    expect(a.target).toBe(100000)
  })
  it('does not count video sent before a late join as lost', () => {
    const a = new CallAdaptation(2000000, 0)
    for (let seq = 900; seq < 930; seq++) a.sentFrame(seq)
    a.feedback(feedback(0, 929, 30), 1000)
    expect(a.target).toBeGreaterThanOrEqual(1200000)
  })
  it('tolerates one frame crossing feedback windows and rejects stale or invalid feedback', () => {
    const a = new CallAdaptation(2000000, 0)
    for (let seq = 0; seq < 20; seq++) a.feedback(feedback(seq, 29 + seq * 30, seq ? 30 : 29), (seq + 1) * 1000)
    expect(a.target).toBe(2000000)
    for (const report of [
      feedback(19, 599, 0), feedback(18, 599, 0),
      { ...feedback(20, 629, 0), interval_ms: 199 },
      { ...feedback(20, 629, 0), received_frames: 301 },
      { ...feedback(20, 629, 0), video_seq: -1 },
      { ...feedback(20, 629, 0), received_bytes: NaN },
    ]) a.feedback(report, 21000)
    expect(a.target).toBe(2000000)
    a.feedback(feedback(20, 629, 10), 21000)
    expect(a.target).toBeLessThan(2000000)
  })
  it('preserves portrait orientation, does not upscale, and accepts sequence wraparound', () => {
    expect(callVideoSize({}, { width: 1080, height: 1920 }, 100000)).toEqual({ width: 144, height: 256 })
    expect(callVideoSize({}, { width: 640, height: 480 }, 2000000)).toEqual({ width: 640, height: 480 })
    const a = new CallAdaptation(2000000, 0)
    a.sentFrame(0xfffffffe)
    a.feedback(feedback(0xffffffff, 0xffffffff, 2), 1000)
    a.feedback(feedback(0, 29, 30), 2000)
    expect(a.target).toBeGreaterThan(1200000)
  })
})
