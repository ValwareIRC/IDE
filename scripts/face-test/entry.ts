// The face engine on its own, for scripts/face-test/index.html.
import { FaceView } from '../../src/renderer/src/lib/faceEngine'
;(window as unknown as Record<string, unknown>)['FaceView'] = FaceView
