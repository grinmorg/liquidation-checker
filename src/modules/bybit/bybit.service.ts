import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TelegramService } from '../telegram-bot/telegram.service';
import { ConfigService } from '@nestjs/config';

// Обработка данных о ликвидациях
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
  private ws: WebSocket;

  constructor(
    private readonly configService: ConfigService,

    private readonly telegramSerivce: TelegramService,
  ) {
    this.reciverTgId = this.configService.getOrThrow('RECIVER_TELEGRAM_ID');
    this.setupWebSocket();
  }

  // Настройка WebSocket для получения данных о ликвидациях
  private setupWebSocket() {
    this.ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    this.ws.on('open', async () => {
      console.log('WebSocket connected to Bybit');

      await this.telegramSerivce.sendMessage(
        this.reciverTgId,
        'Прослушиваем ликвидации Bybit...',
      );

      // Подписка на канал ликвидаций для BTCUSDT
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
      setTimeout(() => this.setupWebSocket(), 5000); // Переподключение через 5 секунд
    });
  }

  private async handleLiquidation(event: LiquidationEvent) {
    if (!event?.data) return;

    // Обработка всех записей
    event.data.map(async (d) => {
      const { S: side, s: symbolPair, p: price, v: volume } = d;
      console.log(
        `Liquidation: ${symbolPair} - SIDE: ${side} - VOLUME: ${volume} - PRICE: ${price} - POSITION: ${parseFloat(price) * parseFloat(volume)}`,
      );
      // ✅
      const symbol = symbolPair.split('USDT')[0];

      const timestamp = event.ts;
      const timeString = new Date(timestamp).toLocaleTimeString('ru-RU');

      const positionSize = Math.round(parseFloat(price) * parseFloat(volume));

      // Порог в 1000$ для фильтрации мелких сделок
      if (positionSize > 1000) {
        await this.telegramSerivce.sendMessage(
          this.reciverTgId,
          `<b>⚠️ (${timeString}) ЛИКВИДАЦИЯ ${side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'} ${side === 'Buy' ? '🟢' : '🔴'} ${symbol}:</b> <i>на сумму ${positionSize}$</i>`,
        );
      }
    });
  }

  // TODO: Механика дальше: Если ликвиднуло ШОРТ 🔴 - встаём в ЛОНГ 🟢 на 10$ и наоборот

  //   private async handleLiquidation(data: any) {
  //     const liquidation = data[0]; // Получаем данные о ликвидации
  //     const symbol = liquidation.symbol;
  //     const side = liquidation.side; // 'Buy' или 'Sell'
  //     const qty = parseFloat(liquidation.qty); // Объем ликвидации

  //     const liquidationThreshold = 10000; // Порог для крупной ликвидации

  //     if (qty > liquidationThreshold) {
  //       console.log(`Large ${side} liquidation detected: ${qty} ${symbol}`);

  //       // Открываем противоположную позицию
  //       const orderSide = side === 'Buy' ? 'Sell' : 'Buy';
  //       await this.placeOrder(symbol, orderSide, qty);
  //     }
  //   }
}
