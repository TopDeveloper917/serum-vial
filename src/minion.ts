import { Market, getLayoutVersion } from '@project-serum/serum'
import { Connection, PublicKey } from '@solana/web3.js'
import { App, HttpRequest, HttpResponse, SHARED_COMPRESSOR, TemplatedApp, WebSocket } from 'uWebSockets.js'
import { isMainThread, threadId, workerData } from 'worker_threads'
import { CHANNELS, MESSAGE_TYPES_PER_CHANNEL, OPS } from './consts'
import {
  CircularBuffer,
  getAllowedValuesText,
  getDidYouMean,
  minionReadyChannel,
  serumDataChannel,
  serumMarketsChannel
} from './helpers'
import { logger } from './logger'
import { MessageEnvelope } from './serum_producer'
import { ErrorResponse, SerumListMarketItem, SerumMarket, SubRequest, SuccessResponse } from './types'

const meta = {
  minionId: threadId
}

if (isMainThread) {
  const message = 'Exiting. Worker is not meant to run in main thread'
  logger.log('error', message, meta)

  throw new Error(message)
}

process.on('unhandledRejection', (err) => {
  throw err
})

// based on https://github.com/uNetworking/uWebSockets.js/issues/335#issuecomment-643500581
const RateLimit = (limit: number, interval: number) => {
  let now = 0
  const last = Symbol(),
    count = Symbol()
  setInterval(() => ++now, interval)
  return (ws: any) => {
    if (ws[last] != now) {
      ws[last] = now
      ws[count] = 1

      return false
    } else {
      return ++ws[count] > limit
    }
  }
}

// Minion is the actual HTTP and WS server implementation
// it is meant to run in Node.js worker_thread and handles:
// - HTTP requests
// - WS subscriptions requests
// - WS data publishing to connected clients

class Minion {
  private readonly _server: TemplatedApp
  private _apiVersion = '1'
  private readonly MAX_MESSAGES_PER_SECOND = 50

  // 100 messages per second limit
  private readonly _wsMessagesRateLimit: (ws: any) => boolean = RateLimit(this.MAX_MESSAGES_PER_SECOND, 1000)

  private readonly _l2SnapshotsSerialized: { [symbol: string]: string } = {}
  private readonly _l3SnapshotsSerialized: { [symbol: string]: string } = {}
  private readonly _recentTrades: { [symbol: string]: CircularBuffer<string> } = {}
  private readonly _recentTradesSerialized: { [symbol: string]: string | undefined } = {}
  private readonly _quotesSerialized: { [symbol: string]: string } = {}
  private readonly _marketNames: string[]

  constructor(private readonly _nodeEndpoint: string, private readonly _markets: SerumMarket[]) {
    this._marketNames = _markets.map((m) => m.name)
    this._server = this._initServer()
  }

  private _initServer() {
    const apiPrefix = `/v${this._apiVersion}`
    return App()
      .ws(`${apiPrefix}/ws`, {
        compression: SHARED_COMPRESSOR,
        maxPayloadLength: 256 * 1024,
        idleTimeout: 5 * 60, // closes WS connection if no message/ping send/received in 5 minutes
        maxBackpressure: 4 * 1024, // close if client is too slow to read the data fast enough
        message: (ws, message) => {
          this._handleSubscriptionRequest(ws, message)
        }
      })

      .get(`${apiPrefix}/markets`, this._listMarkets)
      .get(`${apiPrefix}/recent-trades/:market`, this._listRecentTrades)
  }

  public async start(port: number) {
    return new Promise<void>((resolve, reject) => {
      this._server.listen(port, (socket) => {
        if (socket) {
          logger.log('info', `Listening on port ${port}`, meta)
          resolve()
        } else {
          const message = `Failed to listen on port ${port}`
          logger.log('error', message, meta)
          reject(new Error(message))
        }
      })
    })
  }

  private _listRecentTrades = async (res: HttpResponse, req: HttpRequest) => {
    res.onAborted(() => {
      res.aborted = true
    })

    const marketName = decodeURIComponent(req.getParameter(0))

    const { isValid, error } = this._validateMarketName(marketName)
    if (isValid === false) {
      res.writeHeader('content-type', 'application/json')
      res.writeStatus('400')
      res.end(JSON.stringify({ error }))
      return
    }

    let serializedRecentTrades = this._recentTradesSerialized[marketName]
    if (serializedRecentTrades === undefined) {
      const recentTrades =
        this._recentTrades[marketName] !== undefined ? [...this._recentTrades[marketName]!.items()] : []
      serializedRecentTrades = `[${recentTrades.join(',')}]`
    }

    if (!res.aborted) {
      res.writeHeader('content-type', 'application/json')
      res.end(serializedRecentTrades)
    }
  }

  private _cachedListMarketsResponse: string | undefined = undefined

  //async based on https://github.com/uNetworking/uWebSockets.js/blob/master/examples/AsyncFunction.js
  private _listMarkets = async (res: HttpResponse) => {
    res.onAborted(() => {
      res.aborted = true
    })

    if (this._cachedListMarketsResponse === undefined) {
      const markets = await Promise.all(
        this._markets.map(async (market) => {
          const connection = new Connection(this._nodeEndpoint)
          const { tickSize, minOrderSize, baseMintAddress, quoteMintAddress, programId } = await Market.load(
            connection,
            new PublicKey(market.address),
            undefined,
            new PublicKey(market.programId)
          )

          const [baseCurrency, quoteCurrency] = market.name.split('/')
          const serumMarket: SerumListMarketItem = {
            symbol: market.name,
            baseCurrency: baseCurrency!,
            quoteCurrency: quoteCurrency!,
            version: getLayoutVersion(programId),
            address: market.address,
            programId: market.programId,
            baseMintAddress: baseMintAddress.toBase58(),
            quoteMintAddress: quoteMintAddress.toBase58(),
            tickSize,
            minOrderSize,
            deprecated: market.deprecated
          }
          return serumMarket
        })
      )

      this._cachedListMarketsResponse = JSON.stringify(markets, null, 2)
      serumMarketsChannel.postMessage(this._cachedListMarketsResponse)
    }

    if (!res.aborted) {
      res.writeHeader('content-type', 'application/json')
      res.end(this._cachedListMarketsResponse)
    }
  }

  public initMarketsCache(cachedResponse: string) {
    this._cachedListMarketsResponse = cachedResponse
    logger.log('info', 'Cached markets info response', meta)
  }

  public async processMessage(message: MessageEnvelope) {
    const topic = `${message.type}/${message.symbol}`

    if (logger.level === 'debug') {
      const diff = new Date().valueOf() - new Date(message.timestamp).valueOf()
      logger.log('debug', `Processing message, topic: ${topic}, receive delay: ${diff}ms`, meta)
    }
    if (message.type === 'l2snapshot') {
      this._l2SnapshotsSerialized[message.symbol] = message.payload
    }
    if (message.type === 'l3snapshot') {
      this._l3SnapshotsSerialized[message.symbol] = message.payload
    }

    if (message.type === 'quote') {
      this._quotesSerialized[message.symbol] = message.payload
    }

    if (message.type === 'trade') {
      if (this._recentTrades[message.symbol] === undefined) {
        this._recentTrades[message.symbol] = new CircularBuffer(100)
      }

      this._recentTrades[message.symbol]!.append(message.payload)
      this._recentTradesSerialized[message.symbol] = undefined
    }

    if (message.publish) {
      this._server.publish(topic, message.payload)
    }
  }

  private _handleSubscriptionRequest(ws: WebSocket, buffer: ArrayBuffer) {
    try {
      if (this._wsMessagesRateLimit(ws)) {
        const message = `Too many requests, slow down. Current limit: ${this.MAX_MESSAGES_PER_SECOND} messages per second.`
        logger.log('info', message, meta)

        const errorMessage: ErrorResponse = {
          type: 'error',
          message,
          timestamp: new Date().toISOString()
        }

        ws.send(JSON.stringify(errorMessage))

        return
      }
      const message = Buffer.from(buffer)
      const validationResult = this._validateRequestPayload(message)

      if (validationResult.isValid === false) {
        logger.log('info', `Invalid subscription message received, error: ${validationResult.error}`, {
          message: message.toString(),
          ...meta
        })

        const errorMessage: ErrorResponse = {
          type: 'error',
          message: validationResult.error,
          timestamp: new Date().toISOString()
        }

        ws.send(JSON.stringify(errorMessage))

        return
      }

      const request = validationResult.request

      const confirmationMessage: SuccessResponse = {
        type: request.op == 'subscribe' ? 'subscribed' : 'unsubscribed',
        channel: request.channel,
        markets: request.markets,
        timestamp: new Date().toISOString()
      }

      ws.send(JSON.stringify(confirmationMessage))

      // 'unpack' channel to specific message types that will be published for it
      const requestedTypes = MESSAGE_TYPES_PER_CHANNEL[request.channel]

      for (const type of requestedTypes) {
        for (const market of request.markets) {
          const topic = `${type}/${market}`
          if (request.op === 'subscribe') {
            ws.subscribe(topic)

            if (type === 'quote') {
              const quote = this._quotesSerialized[market]

              if (quote !== undefined) {
                ws.send(quote)
              }
            }

            if (type == 'l2snapshot') {
              const l2Snapshot = this._l2SnapshotsSerialized[market]

              if (l2Snapshot !== undefined) {
                ws.send(l2Snapshot)
              }
            }

            if (type === 'l3snapshot') {
              const l3Snapshot = this._l3SnapshotsSerialized[market]
              if (l3Snapshot !== undefined) {
                ws.send(l3Snapshot)
              }
            }
          } else {
            ws.unsubscribe(topic)
          }
        }
      }

      logger.log('debug', request.op == 'subscribe' ? 'Subscribe successfully' : 'Unsubscribed successfully', {
        successMessage: confirmationMessage,
        ...meta
      })
    } catch (err) {
      const message = 'Subscription request internal error'

      logger.log('info', `${message} , ${err.message} ${err.stack}`, meta)
      try {
        ws.end(1011, message)
      } catch {}
    }
  }

  private _validateMarketName(marketName: string) {
    if (this._marketNames.includes(marketName) === false) {
      const error = `Invalid market name provided: '${marketName}'.${getDidYouMean(
        marketName,
        this._marketNames
      )} ${getAllowedValuesText(this._marketNames)}`

      return {
        isValid: false,
        error
      }
    }

    return {
      isValid: true
    }
  }

  private _validateRequestPayload(message: Buffer) {
    let payload
    try {
      payload = JSON.parse(message as any) as SubRequest
    } catch {
      return {
        isValid: false,
        error: `Invalid JSON.`
      } as const
    }

    if (OPS.includes(payload.op) === false) {
      return {
        isValid: false,
        error: `Invalid op: '${payload.op}'.${getDidYouMean(payload.op, OPS)} ${getAllowedValuesText(OPS)}`
      } as const
    }

    if (CHANNELS.includes(payload.channel) === false) {
      return {
        isValid: false,
        error: `Invalid channel provided: '${payload.channel}'.${getDidYouMean(
          payload.channel,
          CHANNELS
        )}  ${getAllowedValuesText(CHANNELS)}`
      } as const
    }

    if (!Array.isArray(payload.markets) || payload.markets.length === 0) {
      return {
        isValid: false,
        error: `Invalid or empty markets array provided.`
      } as const
    }

    if (payload.markets.length > 40) {
      return {
        isValid: false,
        error: `Too large markets array provided (> 40 items).`
      } as const
    }

    for (const market of payload.markets) {
      if (this._marketNames.includes(market) === false) {
        return {
          isValid: false,
          error: `Invalid market name provided: '${market}'.${getDidYouMean(
            market,
            this._marketNames
          )} ${getAllowedValuesText(this._marketNames)}`
        } as const
      }
    }

    return {
      isValid: true,
      error: undefined,
      request: payload
    } as const
  }
}

const { port, nodeEndpoint, markets } = workerData as { port: number; nodeEndpoint: string; markets: SerumMarket[] }

const minion = new Minion(nodeEndpoint, markets)

minion.start(port).then(() => {
  serumDataChannel.onmessage = (message) => {
    minion.processMessage(message.data)
  }

  serumMarketsChannel.onmessage = (message) => {
    minion.initMarketsCache(message.data)
  }

  minionReadyChannel.postMessage('ready')
})
