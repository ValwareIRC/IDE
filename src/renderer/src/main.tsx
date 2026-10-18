// A window has window.prism from its preload and starts at once. The phone app has none: it pairs with or
// connects to a Prism first (remote/gate.tsx), which then builds window.prism over the encrypted channel.
import { bootMark } from './lib/bootMark'

bootMark('page script running')
if (window.prism) void import('./boot')
else void import('./remote/gate')
