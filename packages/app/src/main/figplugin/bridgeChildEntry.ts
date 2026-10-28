import {
  FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR,
  runFigPluginBridgeChild,
  type FigPluginBridgeChildPort
} from './bridgeChildRuntime'
import { createFigPluginBridgeChildRpcClient } from './bridgeChildRpc'
import { startFigPluginBridgeChildHttpServer } from './bridgeChildHttp'

// Only the fixed Electron utility entry may own parentPort. No stdin/argv/URL fallback.
const parentPort = (process as NodeJS.Process & { parentPort?: FigPluginBridgeChildPort })
  .parentPort
if (process.type !== 'utility' || !parentPort) {
  process.exit(FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR)
} else {
  process.on('uncaughtException', () => process.exit(FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR))
  process.on('unhandledRejection', () => process.exit(FIGPLUGIN_BRIDGE_CHILD_EXIT_PROTOCOL_ERROR))
  let rpc: ReturnType<typeof createFigPluginBridgeChildRpcClient> | undefined
  let http: Awaited<ReturnType<typeof startFigPluginBridgeChildHttpServer>> | undefined
  runFigPluginBridgeChild(parentPort, (code) => process.exit(code), {
    onReady: async (session) => {
      // The runtime owns the sole parentPort listener. The child RPC client is
      // therefore created in passive mode and receives frames via onRpcMessage.
      rpc = createFigPluginBridgeChildRpcClient({
        port: parentPort,
        nonce: session.nonce,
        listen: false
      })
      http = await startFigPluginBridgeChildHttpServer({ origin: session.origin, rpc })
    },
    onRpcMessage: (value) => rpc?.handleMessage(value) === true,
    onShutdown: async () => {
      await http?.close()
      http = undefined
      rpc?.close()
      rpc = undefined
    },
    onProtocolError: () => {
      rpc?.close()
      rpc = undefined
    }
  })
}
