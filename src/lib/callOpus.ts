import createOpus, { type OpusModule } from './opus/opus.js'
import wasmUrl from './opus/opus.wasm?url'

let compiled: Promise<WebAssembly.Module> | undefined

async function loadCompiledOpus(): Promise<WebAssembly.Module> {
  if (typeof window === 'undefined') {
    const fsPromises = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ fsPromises)
    return WebAssembly.compile(await readFile(new URL('./opus/opus.wasm', import.meta.url)))
  }
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error('Audio could not start')
  if (typeof WebAssembly.compileStreaming === 'function' && response.headers.get('content-type')?.includes('application/wasm')) {
    return WebAssembly.compileStreaming(response)
  }
  return WebAssembly.compile(await response.arrayBuffer())
}

function getCompiledOpus(): Promise<WebAssembly.Module> {
  return compiled ??= loadCompiledOpus().catch(error => {
    compiled = undefined
    throw error
  })
}

/** One pinned libopus path preserves 20 ms capture timing and supplies PLC/in-band FEC. */
export class CallOpus {
  private closed = false
  private pcmOffset: number
  private packetOffset: number
  private constructor(private module: OpusModule) {
    this.pcmOffset = module._call_pcm() / 4
    this.packetOffset = module._call_packet()
  }
  static async open() {
    // Compile the precached WASM module once and reuse it for local capture and every participant.
    const wasmModule = await getCompiledOpus()
    const module = await createOpus({
      instantiateWasm(imports, receive) {
        void WebAssembly.instantiate(wasmModule, imports).then(instance => receive(instance, wasmModule))
        return {}
      },
    })
    if (module._call_init() !== 0) throw new Error('Audio could not start')
    return new CallOpus(module)
  }
  encode(pcm: Float32Array): Uint8Array {
    if (this.closed || pcm.length !== 960) throw new Error('Invalid audio frame')
    this.module.HEAPF32.set(pcm, this.pcmOffset)
    const count = this.module._call_encode()
    if (count < 1) throw new Error('Audio encoding failed')
    return this.module.HEAPU8.slice(this.packetOffset, this.packetOffset + count)
  }
  decode(packet?: Uint8Array, fec = false): Float32Array | undefined {
    if (this.closed || (packet && (packet.length > 1275 || !packet.length))) return
    if (packet) this.module.HEAPU8.set(packet, this.packetOffset)
    const count = this.module._call_decode(packet?.length ?? 0, fec ? 1 : 0)
    if (count < 0) return
    return this.module.HEAPF32.slice(this.pcmOffset, this.pcmOffset + count)
  }
  close() { if (!this.closed) { this.closed = true; this.module._call_destroy() } }
}
