import type { OHLCVOptions, Candle, OrderBook, Trade } from '../../types';
import { v } from '../../utils/get-key';
import { jsonParse } from '../../utils/json-parse';
import { calcOrderBookTotal, sortOrderBook } from '../../utils/orderbook';
import { BaseWebSocket } from '../base.ws';

import type { BinanceExchange } from './binance.exchange';
import { BASE_WS_URL, ENDPOINTS } from './binance.types';

type Data = Array<Record<string, any>>;
type MessageHandlers = {
  [topic: string]: (json: Data) => void;
};

export class BinancePublicWebsocket extends BaseWebSocket<BinanceExchange> {
  messageHandlers: MessageHandlers = {
    '24hrTicker': (d: Data) => this.handleTickerStreamEvents(d),
    bookTicker: (d: Data) => this.handleBookTickersStreamEvents(d),
    markPriceUpdate: (d: Data) => this.handleMarkPriceStreamEvents(d),
  };

  connectAndSubscribe = () => {
    if (!this.isDisposed) {
      this.ws = new WebSocket(
        BASE_WS_URL.public[this.parent.options.testnet ? 'testnet' : 'livenet']
      );

      this.ws.addEventListener('open', this.onOpen);
      this.ws.addEventListener('message', this.onMessage);
      this.ws.addEventListener('close', this.onClose);
    }
  };

  onOpen = () => {
    if (!this.isDisposed) {
      const payload = {
        method: 'SUBSCRIBE',
        params: ['!ticker@arr', '!bookTicker', '!markPrice@arr@1s'],
      };

      this.ws?.send?.(JSON.stringify(payload));
    }
  };

  onMessage = ({ data }: MessageEvent) => {
    if (!this.isDisposed) {
      const handlers = Object.entries(this.messageHandlers);

      for (const [topic, handler] of handlers) {
        if (data.includes(`e":"${topic}`)) {
          const json = jsonParse(data);
          if (json) handler(Array.isArray(json) ? json : [json]);
          break;
        }
      }
    }
  };

  handleTickerStreamEvents = (events: Array<Record<string, any>>) => {
    events.forEach((event) => {
      const ticker = this.parent.store.tickers.find(
        (t) => t.symbol === event.s
      );

      if (ticker) {
        this.store.updateTicker(ticker, {
          last: parseFloat(v(event, 'c')),
          percentage: parseFloat(v(event, 'P')),
          volume: parseFloat(v(event, 'v')),
          quoteVolume: parseFloat(v(event, 'q')),
        });
      }
    });
  };

  handleBookTickersStreamEvents = (events: Array<Record<string, any>>) => {
    events.forEach((event) => {
      const ticker = this.parent.store.tickers.find(
        (t) => t.symbol === event.s
      );

      if (ticker) {
        this.store.updateTicker(ticker, {
          bid: parseFloat(v(event, 'b')),
          ask: parseFloat(v(event, 'a')),
        });
      }
    });
  };

  handleMarkPriceStreamEvents = (events: Array<Record<string, any>>) => {
    events.forEach((event) => {
      const ticker = this.parent.store.tickers.find(
        (t) => t.symbol === event.s
      );

      if (ticker) {
        this.store.updateTicker(ticker, {
          mark: parseFloat(v(event, 'p')),
          index: parseFloat(v(event, 'i')),
          fundingRate: parseFloat(v(event, 'r')),
        });
      }
    });
  };

  listenOHLCV = (opts: OHLCVOptions, callback: (candle: Candle) => void) => {
    const topic = `${opts.symbol.toLowerCase()}@kline_${opts.interval}`;

    const waitForConnectedAndSubscribe = () => {
      if (this.isConnected) {
        this.messageHandlers.kline = ([json]: Data) => {
          if (opts.symbol === json.k.s) {
            callback({
              timestamp: json.k.t / 1000,
              open: parseFloat(json.k.o),
              high: parseFloat(json.k.h),
              low: parseFloat(json.k.l),
              close: parseFloat(json.k.c),
              volume: parseFloat(json.k.v),
            });
          }
        };

        const payload = { method: 'SUBSCRIBE', params: [topic], id: 1 };
        this.ws?.send?.(JSON.stringify(payload));
        this.parent.log(`Switched to [${opts.symbol}:${opts.interval}]`);
      } else {
        setTimeout(() => waitForConnectedAndSubscribe(), 100);
      }
    };

    waitForConnectedAndSubscribe();

    return () => {
      delete this.messageHandlers.kline;

      if (this.isConnected) {
        const payload = { method: 'UNSUBSCRIBE', params: [topic], id: 1 };
        this.ws?.send?.(JSON.stringify(payload));
      }
    };
  };

  listenTrades = (symbol: string, callback: (trade: Trade) => void) => {
    const topic = `${symbol.toLowerCase()}@trade`;

    const waitForConnectedAndSubscribe = () => {
      if (this.isConnected) {
        if (!this.isDisposed) {
          this.messageHandlers[topic] = ([trade]: Data) => {
            callback({
              timestamp: trade.E / 1000,
              symbol: trade.s,
              side: trade.m ? 'Buy' : 'Sell',
              size: parseFloat(trade.v),
              price: parseFloat(trade.p),
              id: trade.i,
            });
          };

          const payload = { method: 'SUBSCRIBE', params: [topic], id: 1 };
          this.ws?.send?.(JSON.stringify(payload));
          this.parent.log(`Switched to [${symbol}]`);
        }
      } else {
        setTimeout(() => waitForConnectedAndSubscribe(), 100);
      }
    };

    waitForConnectedAndSubscribe();

    return () => {
      delete this.messageHandlers[topic];

      if (this.isConnected) {
        const payload = { op: 'UNSUBSCRIBE', args: [topic], id: 1 };
        this.ws?.send?.(JSON.stringify(payload));
      }
    };
  };

  listenOrderBook = (
    symbol: string,
    callback: (orderBook: OrderBook) => void
  ) => {
    let timeoutId: NodeJS.Timeout | null = null;

    const topic = `${symbol.toLowerCase()}@depth`;
    const orderBook: OrderBook = { bids: [], asks: [] };
    const innerState = {
      updates: [] as any[],
      isSnapshotLoaded: false,
    };

    const fetchSnapshot = async () => {
      const { data } = await this.parent.xhr.get(ENDPOINTS.ORDERBOOK, {
        params: { symbol, limit: 1000 },
      });

      if (!this.isDisposed) {
        // save snapshot into orderBook object
        orderBook.bids = data.bids.map(([price, amount]: string[]) => ({
          price: parseFloat(price),
          amount: parseFloat(amount),
          total: 0,
        }));

        orderBook.asks = data.asks.map(([price, amount]: string[]) => ({
          price: parseFloat(price),
          amount: parseFloat(amount),
          total: 0,
        }));

        // drop events where u < lastUpdateId
        innerState.updates = innerState.updates.filter(
          (update: Record<string, any>) => update.u > data.lastUpdateId
        );

        // apply all updates
        innerState.updates.forEach((update: Record<string, any>) => {
          this.processOrderBookUpdate(orderBook, update);
        });

        sortOrderBook(orderBook);
        calcOrderBookTotal(orderBook);

        innerState.isSnapshotLoaded = true;
        innerState.updates = [];

        callback(orderBook);
      }
    };

    const waitForConnectedAndSubscribe = () => {
      if (this.isConnected) {
        // 1. subscribe to the topic
        // 2. wait for the first message and send request to snapshot
        // 3. store all incoming updates in an array
        // 4. when the snapshot is received, apply all updates and send the order book to the callback
        // 5. then on each update, apply it to the order book and send it to the callback
        this.messageHandlers.depthUpdate = ([data]: Data) => {
          // incorrect symbol, we don't take account
          if (data.s !== symbol) return;

          // first update, request snapshot
          if (!innerState.isSnapshotLoaded && innerState.updates.length === 0) {
            fetchSnapshot();
            innerState.updates = [data];
            return;
          }

          // more updates, but snapshot is not loaded yet
          if (!innerState.isSnapshotLoaded) {
            innerState.updates.push(data);
            return;
          }

          // snapshot is loaded, apply updates and callback
          this.processOrderBookUpdate(orderBook, data);
          sortOrderBook(orderBook);
          calcOrderBookTotal(orderBook);

          callback(orderBook);
        };

        const payload = { method: 'SUBSCRIBE', params: [topic], id: 1 };
        this.ws?.send?.(JSON.stringify(payload));
      } else {
        timeoutId = setTimeout(() => waitForConnectedAndSubscribe(), 100);
      }
    };

    waitForConnectedAndSubscribe();

    return () => {
      delete this.messageHandlers.depthUpdate;
      orderBook.asks = [];
      orderBook.bids = [];
      innerState.updates = [];
      innerState.isSnapshotLoaded = false;

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (this.isConnected) {
        const payload = { method: 'UNSUBSCRIBE', params: [topic], id: 1 };
        this.ws?.send?.(JSON.stringify(payload));
      }
    };
  };

  private processOrderBookUpdate = (
    orderBook: OrderBook,
    update: Record<string, any>
  ) => {
    const sides = { bids: update.b, asks: update.a };

    Object.entries(sides).forEach(([side, data]) => {
      // we need this for ts compile
      if (side !== 'bids' && side !== 'asks') return;

      data.forEach(([p, a]: string[]) => {
        const price = parseFloat(p);
        const amount = parseFloat(a);
        const index = orderBook[side].findIndex((b) => b.price === price);

        if (index === -1 && amount > 0) {
          orderBook[side].push({ price, amount, total: 0 });
          return;
        }

        if (amount === 0) {
          orderBook[side].splice(index, 1);
          return;
        }

        // eslint-disable-next-line no-param-reassign
        orderBook[side][index].amount = amount;
      });
    });
  };
}
