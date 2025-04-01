import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TelegramService } from '../telegram-bot/telegram.service';
import { ConfigService } from '@nestjs/config';
import { RestClientV5 } from 'bybit-api';
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
      console.log(`[placeOrder] Начало для ${symbol} ${side} ${usdAmount}$`);

      // 1. Проверяем текущие позиции
      console.log(`[placeOrder] Проверка позиций для ${symbol}`);
      const currentPosition = await this.getCurrentPositions(symbol);
      console.log(`[placeOrder] Текущая позиция:`, currentPosition);

      if (currentPosition.side === side && currentPosition.size > 0) {
        const message =
          `<b>⚠️ Пропуск ордера:</b>\n` +
          `Уже есть открытая позиция ${side === 'Buy' ? 'Лонг' : 'Шорт'} по ${symbol}\n` +
          `Текущий размер: ${currentPosition.size}`;

        console.log(`[placeOrder] ${message}`);
        await this.telegramService.sendMessage(this.reciverTgId, message);
        return { skipped: true };
      }

      // 2. Получаем текущую цену
      console.log(`[placeOrder] Получение цены для ${symbol}`);
      const tickerResponse = await this.bybitClient.getTickers({
        category: 'linear',
        symbol,
      });

      if (!tickerResponse.result?.list?.length) {
        throw new Error('Не удалось получить текущую цену');
      }

      const currentPrice = parseFloat(tickerResponse.result.list[0].lastPrice);
      console.log(`[placeOrder] Текущая цена: ${currentPrice}`);

      // 3. Рассчитываем количество
      const qty = usdAmount / currentPrice;
      const minQty = this.getMinQty(symbol); // Функция с минимальными объемами для разных пар
      const roundedQty = this.calculateValidQty(symbol, currentPrice, qty);
      console.log(
        `[placeOrder] Рассчитанное количество: ${roundedQty} (min: ${minQty})`,
      );

      // 4. Настраиваем тейк-профит и стоп-лосс
      const takeProfitPercent = 0.5;
      const stopLossPercent = 0.2;

      const takeProfitPrice =
        side === 'Buy'
          ? (currentPrice * (1 + takeProfitPercent / 100)).toFixed(2)
          : (currentPrice * (1 - takeProfitPercent / 100)).toFixed(2);

      const stopLossPrice =
        side === 'Buy'
          ? (currentPrice * (1 - stopLossPercent / 100)).toFixed(2)
          : (currentPrice * (1 + stopLossPercent / 100)).toFixed(2);

      console.log(`[placeOrder] Параметры ордера:`, {
        takeProfit: takeProfitPrice,
        stopLoss: stopLossPrice,
      });

      // 5. Размещаем ордер
      console.log(`[placeOrder] Отправка ордера на Bybit...`);
      const response = await this.bybitClient.submitOrder({
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: roundedQty.toString(),
        timeInForce: 'GTC',
        isLeverage: 1,
        takeProfit: takeProfitPrice,
        stopLoss: stopLossPrice,
        tpTriggerBy: 'MarkPrice',
        slTriggerBy: 'MarkPrice',
        positionIdx: 0,
      });

      console.log(`[placeOrder] Ответ от Bybit:`, response);

      if (response.retCode === 0) {
        const message =
          `<b>⚡ Ордер исполнен</b>\n` +
          `▸ Символ: <b>${symbol}</b>\n` +
          `▸ Тип: <b>${side === 'Buy' ? 'Лонг' : 'Шорт'}</b>\n` +
          `▸ Объем: <b>${roundedQty} ${symbol.replace('USDT', '')}</b>\n` +
          `▸ Сумма: <b>${usdAmount}$</b>\n` +
          `▸ Цена входа: <b>${currentPrice.toFixed(2)}</b>\n` +
          `▸ Тейк-профит: <b>${takeProfitPrice} (+${takeProfitPercent}%)</b>\n` +
          `▸ Стоп-лосс: <b>${stopLossPrice} (-${stopLossPercent}%)</b>`;

        console.log(`[placeOrder] Успех: ${message}`);
        await this.telegramService.sendMessage(this.reciverTgId, message);

        // Добавляем отслеживание позиции
        const trackedPosition: TrackedPosition = {
          symbol: symbol,
          side: side,
          entryPrice: currentPrice,
          takeProfit: parseFloat(takeProfitPrice),
          stopLoss: parseFloat(stopLossPrice),
          size: parseFloat(roundedQty),
          openedAt: Date.now(),
        };

        this.tradeTracker.trackNewPosition(trackedPosition);
      } else {
        console.error(`[placeOrder] Ошибка от Bybit:`, response);
        throw new Error(
          response.retMsg ||
            `Ошибка размещения ордера: код ${response.retCode}`,
        );
      }

      return response;
    } catch (error) {
      const errorMsg = error.response?.data?.retMsg || error.message;
      const logMessage = `[placeOrder] Ошибка для ${symbol} ${side}: ${errorMsg}`;
      console.error(logMessage, error);

      await this.telegramService.sendMessage(
        this.reciverTgId,
        `<b>❌ Ошибка ордера</b>\n` +
          `▸ Символ: ${symbol}\n` +
          `▸ Причина: ${errorMsg}`,
      );
      throw error;
    }
  }

  private calculateValidQty(
    symbol: string,
    price: number,
    qty: number,
  ): string {
    // Определяем шаг округления в зависимости от цены
    let precision: number;

    if (price >= 10000) {
      precision = 3; // Для активов дороже $10,000 - 3 знака после запятой
    } else if (price >= 1000) {
      precision = 2; // Для активов дороже $1,000 - 2 знака
    } else {
      precision = 1; // Для остальных - 1 знак
    }

    // Получаем минимальный шаг для символа
    const minStep = this.getMinStep(symbol);
    const minQty = this.getMinQty(symbol);

    // Округляем до нужного количества знаков
    let rounded = parseFloat(qty.toFixed(precision));

    // Проверяем, чтобы количество было кратно минимальному шагу
    if (minStep > 0) {
      rounded = Math.round(rounded / minStep) * minStep;
    }

    // Проверяем минимальное количество
    rounded = Math.max(minQty, rounded);

    // Форматируем без лишних нулей
    return rounded.toFixed(precision).replace(/\.?0+$/, '');
  }

  private getMinStep(symbol: string): number {
    // Минимальные шаги для разных пар (можно расширить)
    const minSteps: Record<string, number> = {
      BTCUSDT: 0.001,
      ETHUSDT: 0.01,
      SOLUSDT: 0.1,
      BNBUSDT: 0.01,
    };
    return minSteps[symbol] || 0.001;
  }

  private getMinQty(symbol: string): number {
    // Минимальные объемы для разных пар
    const minQtys: Record<string, number> = {
      BTCUSDT: 0.001,
      ETHUSDT: 0.01,
      SOLUSDT: 0.1,
      BNBUSDT: 0.01,
    };
    return minQtys[symbol] || 0.001;
  }

  private async handleLiquidation(event: LiquidationEvent) {
    if (!event?.data) return;

    for (const d of event.data) {
      const { S: side, s: symbolPair, p: price, v: volume } = d;
      const positionSize = parseFloat(price) * parseFloat(volume);

      console.log(
        `Liquidation: ${symbolPair} - SIDE: ${side} - VOLUME: ${volume} - PRICE: ${price} - POSITION: ${positionSize}`,
      );

      this.updateLiquidationCache(symbolPair, side);

      const timestamp = event.ts;
      const timeString = new Date(timestamp).toLocaleTimeString('ru-RU');

      if (positionSize > 10000) {
        const sideEmoji = side === 'Buy' ? '🟢' : '🔴';
        const sideText = side === 'Buy' ? 'ЛОНГ' : 'ШОРТ';

        await this.telegramService.sendMessage(
          this.reciverTgId,
          `<b>⚠️ (${timeString}) ЛИКВИДАЦИЯ ${sideText} ${sideEmoji} ${symbolPair}:</b>\n` +
            `<i>на сумму ${Math.round(positionSize)}$</i>\n`,
        );
      }

      const timerKey = `${symbolPair}_${side}`;
      const existingTimer = this.timers[timerKey];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const currentLiquidationTime =
        this.liquidationCache[symbolPair]?.[
          side === 'Buy' ? 'lastBuyLiquidation' : 'lastSellLiquidation'
        ] || 0;

      this.timers[timerKey] = setTimeout(async () => {
        const newLiquidationTime =
          this.liquidationCache[symbolPair]?.[
            side === 'Buy' ? 'lastBuyLiquidation' : 'lastSellLiquidation'
          ] || 0;

        if (newLiquidationTime <= currentLiquidationTime) {
          try {
            const tradeSide = side === 'Buy' ? 'Sell' : 'Buy';
            await this.placeOrder(symbolPair, tradeSide, 1000);
          } catch (error) {
            await this.telegramService.sendMessage(
              this.reciverTgId,
              `<b>❌ Ошибка при размещении ордера:</b>\n` +
                `${error.message || 'Неизвестная ошибка'}`,
            );
          }
        }
      }, 10000);
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
