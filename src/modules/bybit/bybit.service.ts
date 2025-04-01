import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TelegramService } from '../telegram-bot/telegram.service';
import { ConfigService } from '@nestjs/config';
import { RestClientV5 } from 'bybit-api';

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

  // Добавляем кэш последних ликвидаций
  private liquidationCache: Record<
    string,
    { lastBuyLiquidation: number; lastSellLiquidation: number }
  > = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly telegramService: TelegramService,
  ) {
    this.reciverTgId = this.configService.getOrThrow('RECIVER_TELEGRAM_ID');

    // Инициализация Bybit REST клиента
    this.bybitClient = new RestClientV5({
      baseUrl: 'https://api-demo.bybit.com',
      key: this.configService.getOrThrow('BYBIT_API_KEY_PUBLIC'),
      secret: this.configService.getOrThrow('BYBIT_API_KEY_SECRET'),
      testnet: false, // Используйте true для тестовой сети
    });

    this.setupWebSocket();
  }

  private async placeOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    usdAmount: number,
  ) {
    try {
      // Проверка временного интервала
      if (!this.checkLiquidationTime(symbol, side)) {
        await this.telegramService.sendMessage(
          this.reciverTgId,
          `<b>⏳ Пропуск ордера:</b>\n` +
            `Слишком частая активность по ${symbol}\n` +
            `Последняя противоположная ликвидация менее 10 сек назад`,
        );
        return { skipped: true };
      }

      // Проверяем текущие позиции
      const currentPosition = await this.getCurrentPositions(symbol);

      // Если уже есть позиция в том же направлении
      if (currentPosition.side === side) {
        await this.telegramService.sendMessage(
          this.reciverTgId,
          `<b>⚠️ Пропуск ордера:</b>\n` +
            `Уже есть открытая позиция ${side === 'Buy' ? 'Лонг' : 'Шорт'} по ${symbol}\n` +
            `Текущий размер: ${currentPosition.size}`,
        );
        return { skipped: true };
      }

      // 1. Получаем текущую рыночную цену
      const tickerResponse = await this.bybitClient.getTickers({
        category: 'linear',
        symbol,
      });

      if (!tickerResponse.result?.list?.length) {
        throw new Error('Не удалось получить текущую цену');
      }

      const currentPrice = parseFloat(tickerResponse.result.list[0].lastPrice);

      // 2. Рассчитываем количество (qty) на основе суммы в USD
      const qty = usdAmount / currentPrice;
      const minQty = 0.001; // Минимальный размер ордера для BTCUSDT
      const roundedQty = Math.max(minQty, parseFloat(qty.toFixed(3)));

      // 3. Рассчитываем уровни тейк-профита и стоп-лосса
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

      // 4. Размещаем ордер
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

      if (response.retCode === 0) {
        console.log('Ордер успешно размещён:', response);

        // 5. Отправляем детали ордера в Telegram
        await this.telegramService.sendMessage(
          this.reciverTgId,
          `<b>⚡ Ордер исполнен</b>\n` +
            `▸ Символ: <b>${symbol}</b>\n` +
            `▸ Тип: <b>${side === 'Buy' ? 'Лонг' : 'Шорт'}</b>\n` +
            `▸ Объем: <b>${roundedQty.toFixed(4)} ${symbol.replace('USDT', '')}</b>\n` +
            `▸ Сумма: <b>${usdAmount}$</b>\n` +
            `▸ Цена входа: <b>${currentPrice.toFixed(2)}</b>\n` +
            `▸ Тейк-профит: <b>${takeProfitPrice} (+${takeProfitPercent}%)</b>\n` +
            `▸ Стоп-лосс: <b>${stopLossPrice} (-${stopLossPercent}%)</b>`,
        );
      }

      return response;
    } catch (error) {
      const errorMsg = error.response?.data?.retMsg || error.message;
      await this.telegramService.sendMessage(
        this.reciverTgId,
        `<b>❌ Ошибка ордера</b>\n` +
          `▸ Символ: ${symbol}\n` +
          `▸ Причина: ${errorMsg}`,
      );
      throw error;
    }
  }

  private async handleLiquidation(event: LiquidationEvent) {
    if (!event?.data) return;

    for (const d of event.data) {
      const { S: side, s: symbolPair, p: price, v: volume } = d;
      const positionSize = parseFloat(price) * parseFloat(volume);

      console.log(
        `Liquidation: ${symbolPair} - SIDE: ${side} - VOLUME: ${volume} - PRICE: ${price} - POSITION: ${positionSize}`,
      );

      // Обновляем кэш ликвидаций
      this.updateLiquidationCache(symbolPair, side);

      // Проверяем временной интервал
      const canTrade = this.checkLiquidationTime(symbolPair, side);
      if (!canTrade) {
        console.log(
          `Пропуск торговой операции для ${symbolPair} - слишком частая ликвидация`,
        );
        continue;
      }

      const timestamp = event.ts;
      const timeString = new Date(timestamp).toLocaleTimeString('ru-RU');

      // Порог в 10000$ для фильтрации мелких сделок
      if (positionSize > 10000) {
        const tradeSide = side === 'Buy' ? 'Sell' : 'Buy';
        const sideEmoji = side === 'Buy' ? '🟢' : '🔴';
        const sideText = side === 'Buy' ? 'ЛОНГ' : 'ШОРТ';

        try {
          // Отправляем уведомление перед размещением ордера
          await this.telegramService.sendMessage(
            this.reciverTgId,
            `<b>⚠️ (${timeString}) ЛИКВИДАЦИЯ ${sideText} ${sideEmoji} ${symbolPair}:</b>\n` +
              `<i>на сумму ${Math.round(positionSize)}$</i>\n`,
          );

          // Размещаем ордер
          await this.placeOrder(symbolPair, tradeSide, 1000); // ордер на 1000$
        } catch (error) {
          await this.telegramService.sendMessage(
            this.reciverTgId,
            `<b>❌ Ошибка при размещении ордера:</b>\n` +
              `${error.message || 'Неизвестная ошибка'}`,
          );
        }
      }
    }
  }

  //  Обновление кэша ликвидаций
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

    // Автоочистка старых записей
    setTimeout(() => {
      if (
        now - this.liquidationCache[symbol].lastBuyLiquidation > 30000 &&
        now - this.liquidationCache[symbol].lastSellLiquidation > 30000
      ) {
        delete this.liquidationCache[symbol];
      }
    }, 30000);
  }

  //  Проверка временного интервала
  private checkLiquidationTime(symbol: string, side: 'Buy' | 'Sell'): boolean {
    const cache = this.liquidationCache[symbol];
    if (!cache) return true;

    const now = Date.now();
    const lastTime =
      side === 'Buy'
        ? cache.lastSellLiquidation // Проверяем противоположное направление
        : cache.lastBuyLiquidation;

    return now - lastTime > 10000; // 10 секунд
  }

  // Получение позиции
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

  private async setupWebSocket() {
    this.ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    this.ws.on('open', async () => {
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
      console.log('Raw data: ', message);
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
