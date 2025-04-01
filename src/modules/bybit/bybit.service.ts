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

      console.log(roundedQty);

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

  private setupWebSocket() {
    this.ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    this.ws.on('open', async () => {
      console.log('ТЕСТОВЫЙ ЛОГ 4');

      console.log('WebSocket connected to Bybit');
      await this.telegramService.sendMessage(
        this.reciverTgId,
        'Прослушиваем ликвидации Bybit...',
      );

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
