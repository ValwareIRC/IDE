// The face in a call: a VRM avatar drawn with three.js, and everything that makes it
// look like someone paying attention. Nothing here knows about the rest of the app:
// what it reacts to comes in through FaceInputs, so it can be tried on its own in a
// plain page (scripts/face-test).
//
// One canvas, moved between the small circle in the call bar and the large tile, so a
// call only ever costs one model and one drawing surface.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'

export type FaceStage = 'listening' | 'heard' | 'working' | 'speaking'

export interface FaceSpeech {
  /** When the voice last reported anything (Date.now()). */
  at: number
  level: number
  /** sound: f1 and f2 are measured from the audio. word: only the word being said is known. */
  source: 'sound' | 'word'
  /** Where the sound's weight sits between 200 and 1000 Hz, and between 1000 and 3200 Hz. */
  f1: number
  f2: number
  word: string
  wordAt: number
}

export interface FaceInputs {
  stage(): FaceStage
  /** How loud you are, roughly 0 to 1. */
  mic(): number
  speech(): FaceSpeech
}

/** head: the face filling a small circle. shoulders: head and shoulders, for the large tile. */
export type FaceFrame = 'head' | 'shoulders'

const VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const
type Vowel = (typeof VOWELS)[number]

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v))
/** Moves toward a goal at a rate that does not depend on how often frames come. */
const ease = (cur: number, goal: number, rate: number, dt: number): number => cur + (goal - cur) * (1 - Math.exp(-rate * dt))
/** 0 to 1 with soft ends. */
const smooth = (v: number): number => {
  const c = clamp(v)
  return c * c * (3 - 2 * c)
}

/** How long each gesture takes, in seconds. */
const LENGTH: Record<string, number> = { wave: 2.4, nod: 1.05, shake: 1.1, smile: 2.2, laugh: 1.7 }

/** Which mouth shape a letter makes, for when only the word is known. */
function letterShape(ch: string): Vowel | 'closed' | 'open' {
  if ('a'.includes(ch)) return 'aa'
  if ('e'.includes(ch)) return 'ee'
  if ('iy'.includes(ch)) return 'ih'
  if ('o'.includes(ch)) return 'oh'
  if ('uw'.includes(ch)) return 'ou'
  if ('mbp'.includes(ch)) return 'closed'
  return 'open'
}

export class FaceView {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(22, 1, 0.05, 20)
  /** Where her eyes are pointed: just beside the camera, moved about a little. */
  private readonly eyesOn = new THREE.Object3D()
  private readonly headAt = new THREE.Vector3()
  private host: HTMLElement | null = null
  private sizer: ResizeObserver | null = null
  private raf = 0
  private last = 0
  private t = 0
  private frame: FaceFrame = 'head'

  private stage: FaceStage = 'listening'
  private stageAt = 0
  private spokeAt = 0
  private blinkAt = 0
  private blinkFrom = -1
  private blinkedTwice = false
  private readonly gaze = new THREE.Vector2()
  private readonly gazeGoal = new THREE.Vector2()
  private gazeNext = 0
  private thinkSide = 1
  private mic = 0
  private tilt = 0
  private nod = 0
  private relaxed = 0
  private pursed = 0
  private readonly mouth: Record<Vowel, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
  /** A gesture the agent asked for, and when it began on the frame clock. */
  private act: { name: string; from: number } | null = null
  private wanted: string | null = null
  /** 0 to 1: how far a close view has pulled back to the head-and-shoulders one (a wave needs the hand in view). */
  private zoom = 0

  private constructor(
    private readonly vrm: VRM,
    private readonly inputs: FaceInputs
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x000000, 0)
    this.canvas = this.renderer.domElement
    this.canvas.className = 'face-canvas'

    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 2)
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 1.1), vrm.scene, this.eyesOn)

    // arms down from the T-pose they come in
    this.turn('leftUpperArm', 0, 0, 1.2)
    this.turn('rightUpperArm', 0, 0, -1.2)
    this.turn('leftLowerArm', 0, 0, 0.15)
    this.turn('rightLowerArm', 0, 0, -0.15)
    vrm.update(0)
    vrm.humanoid.getNormalizedBoneNode('head')?.getWorldPosition(this.headAt)
    vrm.springBoneManager?.reset()
    if (vrm.lookAt) vrm.lookAt.target = this.eyesOn
    this.last = performance.now()
    this.blinkAt = this.last + 1500
  }

  /** Reads a .vrm file. Throws, in words a person can act on, when it is not one. */
  static async create(bytes: ArrayBuffer, inputs: FaceInputs): Promise<FaceView> {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.parseAsync(bytes, '')
    const vrm = gltf.userData['vrm'] as VRM | undefined
    if (!vrm) throw new Error('That file is not a VRM avatar.')
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm)
    // hair swings and the mouth moves outside the bounds the model was saved with
    vrm.scene.traverse((o) => {
      o.frustumCulled = false
    })
    return new FaceView(vrm, inputs)
  }

  /** Wave, nod, shake, smile or laugh, once: the agent's choice, through the gesture tool. */
  gesture(name: string): void {
    if (name in LENGTH) this.wanted = name
  }

  /** Shows the face in this element, filling it, and starts it moving. */
  mount(host: HTMLElement, frame: FaceFrame): void {
    this.host = host
    this.frame = frame
    host.appendChild(this.canvas)
    this.sizer?.disconnect()
    this.sizer = new ResizeObserver(() => this.fit())
    this.sizer.observe(host)
    this.fit()
    if (!this.raf) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  /** Takes the face out of this element, if it is still there. */
  unmount(host: HTMLElement): void {
    if (this.host !== host) return
    this.host = null
    this.sizer?.disconnect()
    this.sizer = null
    this.canvas.remove()
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  dispose(): void {
    if (this.host) this.unmount(this.host)
    VRMUtils.deepDispose(this.vrm.scene)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }

  /** One frame at a given time, without the loop: for trying the face out. */
  stepFor(seconds: number, fps = 30): void {
    const dt = 1 / fps
    for (let s = 0; s < seconds; s += dt) this.step(dt, this.last + s * 1000)
    this.last += seconds * 1000
    this.renderer.render(this.scene, this.camera)
  }

  private readonly loop = (ms: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    // thirty frames a second is plenty for a face, and half the work of sixty
    if (ms - this.last < 1000 / 31) return
    const dt = Math.min(0.1, (ms - this.last) / 1000)
    this.last = ms
    this.step(dt, ms)
    this.renderer.render(this.scene, this.camera)
  }

  private fit(): void {
    const host = this.host
    if (!host) return
    const w = Math.max(1, host.clientWidth)
    const h = Math.max(1, host.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(w, h, false)
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.place()
  }

  /** head: chin to the top of her hair. shoulders: a video call's framing. A close view pulls back while she waves. */
  private place(): void {
    const k = this.frame === 'head' ? this.zoom : 1
    const lift = 0.09 + (0.045 - 0.09) * k
    const distance = 0.78 + (1.25 - 0.78) * k
    this.camera.position.set(this.headAt.x, this.headAt.y + lift, this.headAt.z + distance)
    this.camera.lookAt(this.headAt.x, this.headAt.y + lift, this.headAt.z)
  }

  /** Where the gesture being played has got to: offsets for the head, the arm, the face. */
  private gestureNow(ms: number): { x: number; y: number; z: number; arm: number; swing: number; wrist: number; smile: number; laugh: number; back: number } {
    const none = { x: 0, y: 0, z: 0, arm: 0, swing: 0, wrist: 0, smile: 0, laugh: 0, back: 0 }
    const a = this.act
    if (!a) return none
    const k = (ms - a.from) / 1000
    const long = LENGTH[a.name] ?? 0
    if (k >= long) {
      this.act = null
      return none
    }
    /** Up over `rise` seconds, held, and down over the last `fall`. */
    const env = (rise: number, fall: number): number => smooth(k / rise) * (1 - smooth((k - (long - fall)) / fall))
    const fade = Math.pow(1 - k / long, 0.7)
    switch (a.name) {
      case 'wave': {
        // the hand comes up beside her face, the forearm swings, and the wrist follows a
        // moment behind, which is what makes a wave look loose rather than mechanical
        const arm = env(0.45, 0.55)
        const waving = smooth((k - 0.4) / 0.25) * (1 - smooth((k - (long - 0.75)) / 0.3))
        const phase = Math.PI * 2 * 2.4 * Math.max(0, k - 0.4)
        return { ...none, arm, swing: Math.sin(phase) * waving, wrist: Math.sin(phase - 0.8) * waving, smile: arm * 0.45, back: env(0.35, 0.5), z: arm * 0.05 }
      }
      case 'nod':
        // chin down and back up, twice, the second smaller
        return { ...none, x: -0.13 * Math.abs(Math.sin(Math.PI * 2 * 1.9 * k)) * fade }
      case 'shake':
        return { ...none, y: 0.16 * Math.sin(Math.PI * 2 * 2.3 * k) * fade }
      case 'smile':
        return { ...none, smile: env(0.3, 0.6) }
      case 'laugh': {
        const on = env(0.15, 0.5)
        return { ...none, laugh: on, x: on * (0.04 + 0.03 * Math.sin(Math.PI * 2 * 5 * k)) }
      }
    }
    return none
  }

  private turn(name: VRMHumanBoneName, x: number, y: number, z: number): void {
    this.vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(x, y, z)
  }

  private step(dt: number, ms: number): void {
    const vrm = this.vrm
    const em = vrm.expressionManager
    this.t += dt
    const t = this.t
    const now = Date.now()

    const stage = this.inputs.stage()
    if (stage !== this.stage) {
      this.stage = stage
      this.stageAt = ms
      if (stage === 'working') this.thinkSide = Math.random() < 0.5 ? -1 : 1
    }
    this.mic = ease(this.mic, clamp(this.inputs.mic() * 1.6), 12, dt)
    const sp = this.inputs.speech()
    if (sp.at > now - 200) this.spokeAt = ms

    // ---- a gesture the agent asked for, played once
    if (this.wanted) {
      this.act = { name: this.wanted, from: ms }
      this.wanted = null
    }
    const g = this.gestureNow(ms)
    this.zoom = g.back
    this.place()
    // the right arm: hanging, or raised beside her face and waving
    this.turn('rightUpperArm', 0, 1.1 * g.arm, -1.2 + 0.2 * g.arm)
    this.turn('rightLowerArm', 0, 0.32 * g.swing * g.arm, -0.15 + 2.65 * g.arm)
    this.turn('rightHand', 0, 0, -0.3 * g.wrist * g.arm)

    // ---- blinking: every few seconds, now and then twice
    let blink = 0
    if (this.blinkFrom < 0 && ms >= this.blinkAt) this.blinkFrom = ms
    if (this.blinkFrom >= 0) {
      const k = (ms - this.blinkFrom) / 170
      blink = k < 0.35 ? k / 0.35 : k < 1 ? 1 - (k - 0.35) / 0.65 : 0
      if (k >= 1) {
        this.blinkFrom = -1
        const twice = !this.blinkedTwice && Math.random() < 0.18
        this.blinkedTwice = twice
        this.blinkAt = ms + (twice ? 110 : (stage === 'working' ? 3400 : 2300) + Math.random() * 3600)
      }
    }

    // ---- where she looks: at you, flicking between your eyes; away and up while thinking
    if (ms >= this.gazeNext) {
      if (stage === 'working') {
        this.gazeGoal.set(this.thinkSide * (0.3 + Math.random() * 0.1), 0.2 + Math.random() * 0.08)
        this.gazeNext = ms + 900 + Math.random() * 1600
      } else if (stage === 'speaking' && Math.random() < 0.22) {
        // people glance away mid-sentence, and come back
        this.gazeGoal.set((Math.random() < 0.5 ? -1 : 1) * (0.07 + Math.random() * 0.05), (Math.random() - 0.3) * 0.05)
        this.gazeNext = ms + 450 + Math.random() * 500
      } else {
        this.gazeGoal.set((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.03)
        this.gazeNext = ms + 700 + Math.random() * 1700
      }
    }
    this.gaze.x = ease(this.gaze.x, this.gazeGoal.x, 16, dt)
    this.gaze.y = ease(this.gaze.y, this.gazeGoal.y, 16, dt)
    this.eyesOn.position.set(this.camera.position.x + this.gaze.x, this.camera.position.y + this.gaze.y, this.camera.position.z)

    // ---- the head: never quite still, turning a little after the eyes
    const voice = stage === 'speaking' && sp.at > now - 150 ? sp.level : 0
    this.tilt = ease(this.tilt, stage === 'heard' ? 0.075 : stage === 'listening' ? 0.03 : 0, 3, dt)
    this.nod = ease(this.nod, stage === 'heard' ? this.mic * 0.08 : voice * 0.03, 6, dt)
    const swayY = 0.035 * Math.sin(t * 0.37) + 0.015 * Math.sin(t * 0.91 + 1)
    const swayX = 0.02 * Math.sin(t * 0.29 + 2)
    const swayZ = 0.02 * Math.sin(t * 0.23 + 0.5)
    this.turn('neck', 0, this.gaze.x * 0.2, 0)
    // (a positive turn about x raises her chin: looking up lifts it, a nod lowers it)
    this.turn('head', swayX + this.gaze.y * 0.5 - this.nod + g.x, swayY + this.gaze.x * 0.5 + g.y, swayZ + this.tilt + g.z)
    // breathing, about thirteen breaths a minute
    const breath = Math.sin(t * Math.PI * 2 * 0.22)
    this.turn('spine', breath * 0.006, 0, 0)
    this.turn('chest', breath * 0.012, 0, 0)

    // ---- mood: a soft, settled face while listening and talking; none while thinking
    this.relaxed = ease(this.relaxed, stage === 'speaking' ? 0.3 : stage === 'heard' ? 0.22 : stage === 'listening' ? 0.14 : 0, 3, dt)
    this.pursed = ease(this.pursed, stage === 'working' ? 0.12 : 0, 3, dt)

    // ---- the mouth
    const goal: Record<Vowel, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
    if (stage === 'speaking') {
      if (sp.source === 'sound' && sp.at > now - 150) {
        // How open from how loud; which shape from where the sound sits. A high first
        // resonance is an open jaw (ah, oh); a high second one is a spread mouth (ee, ih).
        // Set against Kokoro's voice (scripts/face-test/bands.cjs): not exact phonetics,
        // but the mouth changes with what is said rather than only with how loudly.
        const open = Math.pow(clamp((sp.level - 0.05) / 0.6), 0.8)
        const jaw = clamp((sp.f1 - 300) / 150)
        const front = clamp((sp.f2 - 1700) / 700)
        const openBack = jaw * (1 - front)
        const openFront = jaw * front
        const closedFront = (1 - jaw) * front
        const closedBack = (1 - jaw) * (1 - front)
        goal.aa = open * (0.4 * openBack + openFront)
        goal.oh = open * 0.6 * openBack
        goal.ee = open * 0.6 * closedFront
        goal.ih = open * 0.4 * closedFront
        goal.ou = open * closedBack
      } else if (sp.source === 'word' && sp.word) {
        // only the word is known: walk through its letters over about the time it takes to say
        const letters = sp.word.toLowerCase().replace(/[^a-z]/g, '')
        const long = Math.max(160, letters.length * 70)
        const k = (now - sp.wordAt) / long
        if (letters && k < 1) {
          const shape = letterShape(letters[Math.min(letters.length - 1, Math.floor(k * letters.length))]!)
          if (shape === 'open') goal.aa = 0.2
          else if (shape !== 'closed') goal[shape] = 0.75
        }
      } else if (this.spokeAt < this.stageAt && ms - this.stageAt > 600) {
        // talking, but the voice reports nothing at all: a gentle made-up rhythm rather than a frozen face
        goal.aa = clamp(0.28 + 0.18 * Math.sin(t * 9.1) + 0.12 * Math.sin(t * 5.3 + 1), 0, 0.5)
      }
    }
    goal.ou = Math.max(goal.ou, this.pursed)
    let total = 0
    for (const v of VOWELS) {
      const g = goal[v]
      this.mouth[v] = ease(this.mouth[v], g, g > this.mouth[v] ? 30 : 14, dt)
      total += this.mouth[v]
    }
    const squeeze = total > 1 ? 1 / total : 1

    if (em) {
      // a laugh closes her eyes already; a blink on top of it would flicker
      em.setValue('blink', blink * (1 - g.laugh))
      em.setValue('relaxed', clamp(this.relaxed + g.smile))
      em.setValue('happy', g.laugh * 0.9)
      for (const v of VOWELS) em.setValue(v, this.mouth[v] * squeeze)
    }
    vrm.update(dt)
  }
}
