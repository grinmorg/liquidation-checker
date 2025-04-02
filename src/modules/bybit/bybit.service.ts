import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TelegramService } from '../telegram-bot/telegram.service';
import { ConfigService } from '@nestjs/config';
import { OrderParamsV5, RestClientV5 } from 'bybit-api';
import { TrackedPosition, TradeTrackerService } from './trade-tracker.service';

interface LiquidationEvent {
  ts: number;
  data?: {
    s: string; // symbol
    S: 'Buy' | 'Sell'; // side
    v: string; // volume
    p: string; // price
  }[];
}

@Injectable()
export class BybitService {
  private readonly reciverTgId: string;
  private readonly bybitClient: RestClientV5;
  private ws: WebSocket;

  private liquidationCache: Record<
    string,
    { lastBuyLiquidation: number; lastSellLiquidation: number }
  > = {};

  private timers: Record<string, NodeJS.Timeout> = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly telegramService: TelegramService,
    private readonly tradeTracker: TradeTrackerService,
  ) {
    this.reciverTgId = this.configService.getOrThrow('RECIVER_TELEGRAM_ID');

    this.bybitClient = new RestClientV5({
      baseUrl: 'https://api-demo.bybit.com',
      key: this.configService.getOrThrow('BYBIT_API_KEY_PUBLIC'),
      secret: this.configService.getOrThrow('BYBIT_API_KEY_SECRET'),
      testnet: false,
    });

    this.setupWebSocket();
  }

  private async placeOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    usdAmount: number,
  ) {
    try {
      console.log(
        `[${new Date().toISOString()}] [placeOrder] Начало для ${symbol} ${side} ${usdAmount}$`,
      );

      // 1. Получение информации о символе
      const symbolInfo = await this.bybitClient.getInstrumentsInfo({
        category: 'linear',
        symbol,
      });

      if (!symbolInfo.result?.list?.[0]) {
        throw new Error(`Символ ${symbol} не найден`);
      }

      const instrument = symbolInfo.result.list[0];
      const priceFilter = instrument.priceFilter;
      const lotSizeFilter = instrument.lotSizeFilter;

      // 2. Проверка текущих позиций
      const currentPosition = await this.getCurrentPositions(symbol);
      if (currentPosition.side === side && currentPosition.size > 0) {
        const message = `<b>⚠️ Пропуск ордера:</b>\nУже есть открытая позиция ${side === 'Buy' ? 'Лонг' : 'Шорт'} по ${symbol}`;
        await this.telegramService.sendMessage(this.reciverTgId, message);
        return { skipped: true };
      }

      // 3. Получение текущей цены
      const tickerResponse = await this.bybitClient.getTickers({
        category: 'linear',
        symbol,
      });

      if (!tickerResponse.result?.list?.[0]?.lastPrice) {
        throw new Error('Не удалось получить цену');
      }

      const currentPrice = parseFloat(tickerResponse.result.list[0].lastPrice);

      // 4. Расчет количества с учетом правил
      const qty = usdAmount / currentPrice;
      const roundedQty = this.calculateValidQty(
        symbol,
        currentPrice,
        qty,
        lotSizeFilter,
      );

      console.log('Рассчитанное количество:', qty, 'Округленное:', roundedQty);

      // 5. Расчет TP/SL
      const takeProfitPercent = 1;
      const stopLossPercent = 0.35;

      const adjustPrice = (price: number) => {
        const tickSize = parseFloat(priceFilter.tickSize);
        return Math.round(price / tickSize) * tickSize;
      };

      const takeProfitPrice = adjustPrice(
        side === 'Buy'
          ? currentPrice * (1 + takeProfitPercent / 100)
          : currentPrice * (1 - takeProfitPercent / 100),
      );

      const stopLossPrice = adjustPrice(
        side === 'Buy'
          ? currentPrice * (1 - stopLossPercent / 100)
          : currentPrice * (1 + stopLossPercent / 100),
      );

      // 6. Отправка ордера
      const orderPayload: OrderParamsV5 = {
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: roundedQty,
        timeInForce: 'GTC',
        isLeverage: 1,
        takeProfit: takeProfitPrice.toFixed(parseInt(instrument.priceScale)),
        stopLoss: stopLossPrice.toFixed(parseInt(instrument.priceScale)),
        tpTriggerBy: 'MarkPrice',
        slTriggerBy: 'MarkPrice',
        positionIdx: 0, // Исправлено: One-way mode
      };

      console.log('Order payload:', orderPayload);

      const response = await this.bybitClient.submitOrder(orderPayload);
      console.log('Ответ Bybit:', JSON.stringify(response, null, 2));

      // 7. Обработка ответа
      if (response.retCode === 0) {
        const message = `<b>⚡ Ордер исполнен</b>\n▸ Символ: <b>${symbol}</b>\n▸ Тип: <b>${side}</b>`;
        await this.telegramService.sendMessage(this.reciverTgId, message);

        const trackedPosition: TrackedPosition = {
          symbol,
          side,
          entryPrice: currentPrice,
          takeProfit: takeProfitPrice,
          stopLoss: stopLossPrice,
          size: parseFloat(roundedQty),
          openedAt: Date.now(),
        };

        this.tradeTracker.trackNewPosition(trackedPosition);
        return response;
      } else {
        throw new Error(response.retMsg || 'Unknown error');
      }
    } catch (error) {
      const errorMsg = error.response?.data?.retMsg || error.message;
      console.error('Ошибка размещения ордера:', errorMsg);
      await this.telegramService.sendMessage(
        this.reciverTgId,
        `<b>❌ Ошибка:</b> ${symbol} - ${errorMsg}`,
      );
      throw error;
    }
  }

  private calculateValidQty(
    symbol: string,
    price: number,
    qty: number,
    lotSizeFilter: any,
  ): string {
    const minQty = parseFloat(lotSizeFilter.minOrderQty);
    const maxQty = parseFloat(lotSizeFilter.maxOrderQty);
    const qtyStep = parseFloat(lotSizeFilter.qtyStep);

    let validQty = Math.max(minQty, qty);
    validQty = Math.min(maxQty, validQty);
    validQty = Math.round(validQty / qtyStep) * qtyStep;

    return validQty.toFixed(this.getPrecision(qtyStep));
  }

  private getPrecision(step: number): number {
    return step.toString().split('.')[1]?.length || 0;
  }

  private async handleLiquidation(event: LiquidationEvent) {
    if (!event?.data) return;

    for (const d of event.data) {
      const { S: side, s: symbolPair, p: price, v: volume } = d;
      const positionSize = parseFloat(price) * parseFloat(volume);

      // Игнорируем ликвидации меньше $1,000
      if (positionSize < 1000) {
        continue;
      }

      console.log(
        `Liquidation: ${symbolPair} - SIDE: ${side} - VOLUME: ${volume} - PRICE: ${price} - POSITION: ${positionSize}`,
      );

      this.updateLiquidationCache(symbolPair, side);

      const timestamp = event.ts;
      const timeString = new Date(timestamp).toLocaleTimeString('ru-RU');

      // Уведомление для крупных ликвидаций (>$100k)
      if (positionSize > 100000) {
        const sideEmoji = side === 'Buy' ? '🟢' : '🔴';
        const sideText = side === 'Buy' ? 'ЛОНГ' : 'ШОРТ';

        await this.telegramService.sendMessage(
          this.reciverTgId,
          `<b>⚠️ (${timeString}) КРУПНАЯ ЛИКВИДАЦИЯ ${sideText} ${sideEmoji} ${symbolPair}:</b>\n` +
            `<i>на сумму ${Math.round(positionSize)}$</i>\n` +
            `<i>Ожидаем окончания каскада...</i>`,
        );
      }

      const timerKey = `${symbolPair}_${side}`;
      const existingTimer = this.timers[timerKey];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Запоминаем время последней ликвидации
      const lastLiquidationTime =
        this.liquidationCache[symbolPair]?.[
          side === 'Buy' ? 'lastBuyLiquidation' : 'lastSellLiquidation'
        ] || 0;

      // Устанавливаем таймер на 10 секунд
      this.timers[timerKey] = setTimeout(async () => {
        // Проверяем, были ли новые ликвидации за последние 10 секунд
        const currentLiquidationTime =
          this.liquidationCache[symbolPair]?.[
            side === 'Buy' ? 'lastBuyLiquidation' : 'lastSellLiquidation'
          ] || 0;

        if (currentLiquidationTime <= lastLiquidationTime) {
          try {
            const tradeSide = side === 'Buy' ? 'Sell' : 'Buy';
            await this.telegramService.sendMessage(
              this.reciverTgId,
              `<b>⚡ Размещаем ордер после ликвидации:</b>\n` +
                `▸ Символ: ${symbolPair}\n` +
                `▸ Направление: ${tradeSide === 'Buy' ? 'Лонг' : 'Шорт'}`,
            );
            await this.placeOrder(symbolPair, tradeSide, 1000);
          } catch (error) {
            await this.telegramService.sendMessage(
              this.reciverTgId,
              `<b>❌ Ошибка при размещении ордера:</b>\n` +
                `${error.message || 'Неизвестная ошибка'}`,
            );
          }
        } else {
          await this.telegramService.sendMessage(
            this.reciverTgId,
            `<b>⚠️ Обнаружен каскад ликвидаций:</b>\n` +
              `▸ Символ: ${symbolPair}\n` +
              `▸ Продолжаем наблюдение...`,
          );
        }
      }, 10000); // Ждем 10 секунд
    }
  }

  private updateLiquidationCache(symbol: string, side: 'Buy' | 'Sell') {
    if (!this.liquidationCache[symbol]) {
      this.liquidationCache[symbol] = {
        lastBuyLiquidation: 0,
        lastSellLiquidation: 0,
      };
    }

    const now = Date.now();
    if (side === 'Buy') {
      this.liquidationCache[symbol].lastBuyLiquidation = now;
    } else {
      this.liquidationCache[symbol].lastSellLiquidation = now;
    }

    // Очищаем кэш через 30 секунд неактивности
    setTimeout(() => {
      if (
        now - this.liquidationCache[symbol].lastBuyLiquidation > 30000 &&
        now - this.liquidationCache[symbol].lastSellLiquidation > 30000
      ) {
        delete this.liquidationCache[symbol];
      }
    }, 30000);
  }

  private async getCurrentPositions(symbol: string): Promise<{
    side: 'Buy' | 'Sell' | 'None';
    size: number;
  }> {
    try {
      const response = await this.bybitClient.getPositionInfo({
        category: 'linear',
        symbol: symbol,
      });

      if (response.retCode !== 0 || !response.result?.list?.length) {
        return { side: 'None', size: 0 };
      }

      const position = response.result.list[0];
      const size = parseFloat(position.size);

      if (size === 0) {
        return { side: 'None', size: 0 };
      }

      return {
        side: position.side === 'Buy' ? 'Buy' : 'Sell',
        size: size,
      };
    } catch (error) {
      console.error('Error getting positions:', error);
      return { side: 'None', size: 0 };
    }
  }

  private setupWebSocket() {
    this.ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    this.ws.on('open', () => {
      console.log('WebSocket connected to Bybit');
      this.ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: [
            'allLiquidation.BTCUSDT',
            'allLiquidation.ETHUSDT',
            'allLiquidation.SOLUSDT',
            'allLiquidation.BNBUSDT',
            'allLiquidation.1000PEPEUSDT',
          ],
        }),
      );
    });

    this.ws.on('message', async (data: Buffer) => {
      const message = JSON.parse(data.toString());
      await this.handleLiquidation(message);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('WebSocket disconnected. Reconnecting...');
      setTimeout(() => this.setupWebSocket(), 5000);
    });
  }
}
