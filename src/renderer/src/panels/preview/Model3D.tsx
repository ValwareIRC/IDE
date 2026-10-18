import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from '@react-three/fiber'
import { Bounds, ContactShadows, Environment, Grid, Html, Lightformer, Line, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { Camera, Film, Layers, Pause, Play, Ruler } from 'lucide-react'
import { prism } from '@/lib/ipc'
import { useLayout } from '@/state/layout'
import { useSessions } from '@/state/sessions'
import { toastError, useUi } from '@/state/ui'
import { extname, cx } from '@/lib/format'

interface Loaded {
  object: THREE.Object3D
  clips: THREE.AnimationClip[]
}

interface MaterialInfo {
  id: string
  name: string
  kind: string
  color: string | null
  roughness: number | null
  metalness: number | null
  opacity: number
  maps: Array<{ slot: string; size: string }>
  meshes: number
}

interface Stats {
  meshes: number
  triangles: number
  vertices: number
  size: [number, number, number]
  materials: MaterialInfo[]
}

const MAP_SLOTS: Array<[string, string]> = [
  ['map', 'colour'],
  ['normalMap', 'normal'],
  ['roughnessMap', 'roughness'],
  ['metalnessMap', 'metalness'],
  ['emissiveMap', 'glow'],
  ['aoMap', 'shadowing'],
  ['alphaMap', 'transparency']
]

function GltfModel({ url, onLoad }: { url: string; onLoad: (l: Loaded) => void }): React.JSX.Element {
  const gltf = useGLTF(url)
  useEffect(() => onLoad({ object: gltf.scene, clips: gltf.animations }), [gltf, onLoad])
  return <primitive object={gltf.scene} />
}

function ObjModel({ url, onLoad }: { url: string; onLoad: (l: Loaded) => void }): React.JSX.Element {
  const obj = useLoader(OBJLoader, url)
  useEffect(() => {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && !(mesh.material as THREE.Material & { map?: unknown }).map) {
        mesh.material = new THREE.MeshStandardMaterial({ color: '#b8c0d0', metalness: 0.1, roughness: 0.6 })
      }
    })
    onLoad({ object: obj, clips: [] })
  }, [obj, onLoad])
  return <primitive object={obj} />
}

function FbxModel({ url, onLoad }: { url: string; onLoad: (l: Loaded) => void }): React.JSX.Element {
  const fbx = useLoader(FBXLoader, url)
  useEffect(() => onLoad({ object: fbx, clips: fbx.animations ?? [] }), [fbx, onLoad])
  return <primitive object={fbx} />
}

function GeometryModel({ url, kind, onLoad }: { url: string; kind: 'stl' | 'ply'; onLoad: (l: Loaded) => void }): React.JSX.Element {
  const geom = useLoader(kind === 'stl' ? STLLoader : PLYLoader, url) as THREE.BufferGeometry
  const mesh = useRef<THREE.Mesh>(null)
  useEffect(() => {
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    if (mesh.current) onLoad({ object: mesh.current, clips: [] })
  }, [geom, onLoad])
  const hasColor = !!geom.getAttribute('color')
  return (
    <mesh ref={mesh} geometry={geom}>
      <meshStandardMaterial color={hasColor ? '#ffffff' : '#b8c0d0'} vertexColors={hasColor} metalness={0.15} roughness={0.55} />
    </mesh>
  )
}

function Model({ url, ext, onLoad }: { url: string; ext: string; onLoad: (l: Loaded) => void }): React.JSX.Element {
  if (ext === '.obj') return <ObjModel url={url} onLoad={onLoad} />
  if (ext === '.fbx') return <FbxModel url={url} onLoad={onLoad} />
  if (ext === '.stl') return <GeometryModel url={url} kind="stl" onLoad={onLoad} />
  if (ext === '.ply') return <GeometryModel url={url} kind="ply" onLoad={onLoad} />
  return <GltfModel url={url} onLoad={onLoad} />
}

function measure(object: THREE.Object3D): Stats {
  let meshes = 0
  let triangles = 0
  let vertices = 0
  const mats = new Map<string, MaterialInfo>()
  object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    meshes += 1
    const g = mesh.geometry
    const pos = g.getAttribute('position')
    vertices += pos?.count ?? 0
    triangles += Math.floor((g.index ? g.index.count : (pos?.count ?? 0)) / 3)
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!m) continue
      const seen = mats.get(m.uuid)
      if (seen) {
        seen.meshes += 1
        continue
      }
      const any = m as THREE.MeshStandardMaterial
      const maps: MaterialInfo['maps'] = []
      for (const [slot, label] of MAP_SLOTS) {
        const tex = (m as unknown as Record<string, THREE.Texture | null | undefined>)[slot]
        const img = tex?.image as { width?: number; height?: number } | undefined
        if (tex) maps.push({ slot: label, size: img?.width ? `${img.width}×${img.height}` : '' })
      }
      mats.set(m.uuid, {
        id: m.uuid,
        name: m.name || `material ${mats.size + 1}`,
        kind: m.type.replace(/^Mesh|Material$/g, '') || m.type,
        color: any.color ? `#${any.color.getHexString()}` : null,
        roughness: typeof any.roughness === 'number' ? any.roughness : null,
        metalness: typeof any.metalness === 'number' ? any.metalness : null,
        opacity: m.opacity,
        maps,
        meshes: 1
      })
    }
  })
  const box = new THREE.Box3().setFromObject(object)
  const s = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  return { meshes, triangles, vertices, size: [s.x, s.y, s.z], materials: [...mats.values()] }
}

interface Rig {
  gl: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.Camera
  controls: { target: THREE.Vector3; update(): void } | null
}

/** Hands the renderer, scene and camera to the panel outside the canvas. */
function Bridge({ rig }: { rig: React.MutableRefObject<Rig | null> }): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as Rig['controls']
  useEffect(() => {
    rig.current = { gl, scene, camera, controls }
  }, [gl, scene, camera, controls, rig])
  return null
}

interface Playback {
  clip: number
  playing: boolean
  speed: number
}

function Animator({ loaded, play, seek, onTime }: { loaded: Loaded; play: Playback; seek: React.MutableRefObject<number | null>; onTime: (t: number, duration: number) => void }): null {
  const mixer = useMemo(() => new THREE.AnimationMixer(loaded.object), [loaded.object])
  const action = useRef<THREE.AnimationAction | null>(null)
  const last = useRef(0)
  useEffect(() => {
    const clip = loaded.clips[play.clip]
    mixer.stopAllAction()
    if (!clip) return
    const a = mixer.clipAction(clip)
    a.play()
    action.current = a
    return () => {
      a.stop()
    }
  }, [mixer, loaded.clips, play.clip])
  useFrame((_, dt) => {
    const a = action.current
    if (!a) return
    if (seek.current !== null) {
      a.time = seek.current
      seek.current = null
      mixer.update(0)
    } else if (play.playing) mixer.update(dt * play.speed)
    const now = performance.now()
    if (now - last.current > 90) {
      last.current = now
      onTime(a.time, a.getClip().duration)
    }
  })
  return null
}

function Wireframe({ on, solo, children }: { on: boolean; solo: string | null; children: React.ReactNode }): React.JSX.Element {
  return (
    <group
      ref={(g) => {
        if (!g) return
        g.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats) if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = on
          // "only this material": everything made of something else is hidden
          mesh.visible = !solo || mats.some((m) => m.uuid === solo)
        })
      }}
    >
      {children}
    </group>
  )
}

const fmt = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3))
const b64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function Model3D({ url, path }: { url: string; path: string }): React.JSX.Element {
  const ext = extname(path)
  const unit = ext === '.glb' || ext === '.gltf' ? ' m' : ''
  const [wire, setWire] = useState(false)
  const [grid, setGrid] = useState(true)
  const [env, setEnv] = useState<'studio' | 'warm' | 'cool'>('studio')
  const [spin, setSpin] = useState(true)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [showMats, setShowMats] = useState(false)
  const [solo, setSolo] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [points, setPoints] = useState<THREE.Vector3[]>([])
  const [play, setPlay] = useState<Playback>({ clip: 0, playing: true, speed: 1 })
  const [clock, setClock] = useState({ t: 0, d: 0 })
  const [busy, setBusy] = useState<string | null>(null)
  const rig = useRef<Rig | null>(null)
  const seek = useRef<number | null>(null)
  const tint = env === 'warm' ? '#ffd9b0' : env === 'cool' ? '#b9d8ff' : '#ffffff'

  // stable, so the loaders' effects do not run on every render
  const onLoad = useRef((l: Loaded): void => {
    setLoaded(l)
    setStats(measure(l.object))
  }).current

  useEffect(() => {
    setLoaded(null)
    setStats(null)
    setPoints([])
    setSolo(null)
  }, [url])

  const dot = stats ? Math.max(...stats.size) * 0.012 || 0.01 : 0.01
  const onPick = (e: ThreeEvent<MouseEvent>): void => {
    if (!measuring) return
    e.stopPropagation()
    setPoints((p) => (p.length >= 2 ? [e.point.clone()] : [...p, e.point.clone()]))
  }
  const distance = points.length === 2 ? points[0]!.distanceTo(points[1]!) : null

  /** One frame of the canvas as a picture, on the panel's background colour. */
  const frame = (w: number, h: number, g: CanvasRenderingContext2D): void => {
    const r = rig.current!
    r.gl.render(r.scene, r.camera)
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim() || '#0b0d13'
    g.fillRect(0, 0, w, h)
    g.drawImage(r.gl.domElement, 0, 0, w, h)
  }

  const turntable = async (): Promise<void> => {
    const r = rig.current
    if (!r || busy) return
    const wasSpinning = spin
    setSpin(false)
    setBusy('Recording…')
    const cam = r.camera
    const home = cam.position.clone()
    try {
      const src = r.gl.domElement
      const w = 480
      const h = Math.max(120, Math.round((w * src.height) / src.width))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d', { willReadFrequently: true })!
      const target = r.controls?.target.clone() ?? new THREE.Vector3()
      const off = home.clone().sub(target)
      const radius = Math.hypot(off.x, off.z)
      const start = Math.atan2(off.x, off.z)
      const frames = 48
      const gif = GIFEncoder()
      for (let i = 0; i < frames; i += 1) {
        const a = start + (i / frames) * Math.PI * 2
        cam.position.set(target.x + Math.sin(a) * radius, home.y, target.z + Math.cos(a) * radius)
        cam.lookAt(target)
        cam.updateMatrixWorld()
        frame(w, h, g)
        const data = g.getImageData(0, 0, w, h).data
        const palette = quantize(data, 256)
        gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 70 })
        if (i % 6 === 5) {
          setBusy(`Recording… ${Math.round(((i + 1) / frames) * 100)}%`)
          await new Promise((res) => requestAnimationFrame(res))
        }
      }
      gif.finish()
      const out = path.replace(/\.[^./]+$/, '') + '-turntable.gif'
      await prism.fs.writeBinary(out, b64(gif.bytes()))
      useUi.getState().toast('success', 'Turntable saved', out)
      useLayout.getState().openPreviewBeside(out)
    } catch (e) {
      toastError(e, 'Could not record the turntable')
    } finally {
      cam.position.copy(home)
      r.controls?.update()
      setBusy(null)
      setSpin(wasSpinning)
    }
  }

  const showAgent = async (): Promise<void> => {
    const r = rig.current
    if (!r) return
    try {
      const src = r.gl.domElement
      const w = Math.min(1200, src.width)
      const h = Math.round((w * src.height) / src.width)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      frame(w, h, c.getContext('2d')!)
      const data = c.toDataURL('image/png')
      const att = await prism.attachments.fromData('model.png', 'image/png', data.slice(data.indexOf(',') + 1))
      useLayout.getState().openAgent()
      const st = useSessions.getState()
      const give = (id: string): void => useSessions.getState().hand(id, `Here is how @${path} looks from this angle.\n\n`, [att])
      if (st.active) give(st.active)
      else void st.create().then((s) => s && give(s.id))
    } catch (e) {
      toastError(e, 'Could not take the picture')
    }
  }

  return (
    <div className="viewer3d">
      <Canvas key={url} shadows dpr={[1, 2]} camera={{ position: [3, 2, 4], fov: 45, near: 0.01, far: 1000 }} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping }} style={{ background: 'transparent' }}>
        <Bridge rig={rig} />
        <Suspense fallback={null}>
          {/* Procedural studio: no files, no network. */}
          <Environment resolution={256} frames={1}>
            <color attach="background" args={['#0b0d13']} />
            <Lightformer intensity={2.2} color={tint} position={[0, 5, -6]} rotation={[Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
            <Lightformer intensity={1.2} color={tint} position={[-6, 2, 2]} rotation={[0, Math.PI / 2, 0]} scale={[6, 4, 1]} />
            <Lightformer intensity={0.8} color="#8ad8ff" position={[6, 1, -2]} rotation={[0, -Math.PI / 2, 0]} scale={[6, 3, 1]} />
            <Lightformer intensity={0.4} color="#b9a7ff" position={[0, -4, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
          </Environment>
          <ambientLight intensity={0.2} />
          <directionalLight position={[5, 8, 5]} intensity={1.4} color={tint} castShadow shadow-mapSize={[2048, 2048]} />
          <Bounds fit clip observe margin={2.4}>
            <group onClick={onPick}>
              <Wireframe on={wire} solo={solo}>
                <Model url={url} ext={ext} onLoad={onLoad} />
              </Wireframe>
            </group>
          </Bounds>
          {loaded && loaded.clips.length > 0 && <Animator loaded={loaded} play={play} seek={seek} onTime={(t, d) => setClock({ t, d })} />}
          {points.map((p, i) => (
            <mesh key={i} position={p}>
              <sphereGeometry args={[dot, 16, 16]} />
              <meshBasicMaterial color="#ff5c8a" depthTest={false} />
            </mesh>
          ))}
          {points.length === 2 && (
            <>
              <Line points={[points[0]!, points[1]!]} color="#ff5c8a" lineWidth={2} depthTest={false} />
              <Html position={points[0]!.clone().lerp(points[1]!, 0.5)} center>
                <div className="measure-tag">
                  {fmt(distance ?? 0)}
                  {unit}
                </div>
              </Html>
            </>
          )}
          <ContactShadows position={[0, -0.001, 0]} opacity={0.45} scale={12} blur={2.2} far={6} />
          {grid && <Grid args={[20, 20]} cellColor="#2a3040" sectionColor="#3b4458" cellThickness={0.6} sectionThickness={1} fadeDistance={22} fadeStrength={1.6} infiniteGrid position={[0, -0.002, 0]} />}
        </Suspense>
        <OrbitControls makeDefault autoRotate={spin && !measuring} autoRotateSpeed={0.8} enableDamping dampingFactor={0.08} />
      </Canvas>

      {stats && (
        <div className="viewer3d-info">
          <span>
            {stats.meshes} part{stats.meshes === 1 ? '' : 's'} · {stats.triangles.toLocaleString()} triangles · {stats.vertices.toLocaleString()} points
          </span>
          <span title="Width × height × depth">
            {fmt(stats.size[0])} × {fmt(stats.size[1])} × {fmt(stats.size[2])}
            {unit}
          </span>
        </div>
      )}
      {measuring && <div className="viewer3d-tip">{points.length === 1 ? 'Click a second point.' : distance !== null ? `${fmt(distance)}${unit} between the two points. Click again to start over.` : 'Click two points on the model to measure between them.'}</div>}
      {busy && <div className="viewer3d-tip">{busy}</div>}

      {showMats && stats && (
        <div className="viewer3d-mats">
          <div className="hud-label">Materials</div>
          {stats.materials.map((m) => (
            <button key={m.id} className={cx('mat-row', solo === m.id && 'on')} onClick={() => setSolo((s) => (s === m.id ? null : m.id))} title={solo === m.id ? 'Show everything again' : 'Show only the parts made of this'}>
              <span className="mat-swatch" style={{ background: m.color ?? 'transparent' }} />
              <span className="mat-main">
                <span className="truncate">{m.name}</span>
                <span className="faint xs">
                  {m.kind}
                  {m.roughness !== null ? ` · rough ${m.roughness.toFixed(2)}` : ''}
                  {m.metalness !== null ? ` · metal ${m.metalness.toFixed(2)}` : ''}
                  {m.opacity < 1 ? ` · ${Math.round(m.opacity * 100)}% solid` : ''}
                </span>
                {m.maps.length > 0 && <span className="faint xs">pictures: {m.maps.map((x) => `${x.slot}${x.size ? ` ${x.size}` : ''}`).join(', ')}</span>}
              </span>
              <span className="faint xs">
                {m.meshes} part{m.meshes === 1 ? '' : 's'}
              </span>
            </button>
          ))}
          {!stats.materials.length && <div className="faint small">This model has no materials.</div>}
        </div>
      )}

      <div className="viewer3d-bottom">
      {loaded && loaded.clips.length > 0 && (
        <div className="viewer3d-anim">
          <button className="icon-btn sm" title={play.playing ? 'Pause' : 'Play'} onClick={() => setPlay((p) => ({ ...p, playing: !p.playing }))}>
            {play.playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {loaded.clips.length > 1 ? (
            <select className="input sm" value={play.clip} onChange={(e) => setPlay((p) => ({ ...p, clip: Number(e.target.value) }))}>
              {loaded.clips.map((c, i) => (
                <option key={i} value={i}>
                  {c.name || `animation ${i + 1}`}
                </option>
              ))}
            </select>
          ) : (
            <span className="small truncate">{loaded.clips[0]!.name || 'animation'}</span>
          )}
          <input
            className="range grow"
            type="range"
            min={0}
            max={clock.d || 1}
            step={0.01}
            value={Math.min(clock.t, clock.d || 1)}
            onChange={(e) => {
              seek.current = Number(e.target.value)
              setClock((c) => ({ ...c, t: Number(e.target.value) }))
            }}
          />
          <span className="mono xs faint">
            {clock.t.toFixed(1)} / {clock.d.toFixed(1)} s
          </span>
          <div className="seg">
            {[0.25, 0.5, 1, 2].map((s) => (
              <button key={s} className={cx(play.speed === s && 'on')} onClick={() => setPlay((p) => ({ ...p, speed: s }))}>
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="viewer3d-hud">
        <button className={cx('chip clickable', spin && 'accent')} onClick={() => setSpin((v) => !v)}>
          orbit
        </button>
        <button className={cx('chip clickable', wire && 'accent')} onClick={() => setWire((v) => !v)}>
          wireframe
        </button>
        <button className={cx('chip clickable', grid && 'accent')} onClick={() => setGrid((v) => !v)}>
          grid
        </button>
        <button
          className={cx('chip clickable', measuring && 'accent')}
          onClick={() => {
            setMeasuring((v) => !v)
            setPoints([])
          }}
          title="Measure between two points"
        >
          <Ruler size={11} /> measure
        </button>
        <button className={cx('chip clickable', showMats && 'accent')} onClick={() => setShowMats((v) => !v)} title="What the model is made of">
          <Layers size={11} /> materials
        </button>
        <button className="chip clickable" disabled={!!busy} onClick={() => void turntable()} title="Save a GIF of the model turning once around">
          <Film size={11} /> turntable GIF
        </button>
        <button className="chip clickable" onClick={() => void showAgent()} title="Put a picture of this view in the message box">
          <Camera size={11} /> show the agent
        </button>
        <span className="grow" />
        {(['studio', 'warm', 'cool'] as const).map((e) => (
          <button key={e} className={cx('chip clickable', env === e && 'accent')} onClick={() => setEnv(e)}>
            {e}
          </button>
        ))}
      </div>
      </div>
    </div>
  )
}
