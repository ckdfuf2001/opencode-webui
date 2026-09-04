let ctx: AudioContext | null = null

/**
 * Short "tick" played when a response finishes generating. Synthesized with
 * Web Audio so no asset file ships with the app. Browsers require a prior
 * user gesture before audio may play — if the context is still suspended the
 * sound is skipped silently.
 */
export async function playCompletionTick(): Promise<void> {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        return
      }
      if (ctx.state === 'suspended') return
    }
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.08)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.15)
  } catch {
    // audio unavailable — never break the app over a sound
  }
}

export function playCancelTick(): Promise<void> {
  // cancel uses same tick but slightly lower pitch so user can distinguish if needed
  return playCompletionTick()
}
