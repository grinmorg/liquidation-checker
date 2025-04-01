// src/trading/trading-analytics.service.ts
import { Injectable } from '@nestjs/common';
import { TelegramService } from '../telegram-bot/telegram.service';
import { ConfigService } from '@nestjs/config';

export interface TradePosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  timestamp: number;
  closedType?: 'TP' | 'SL' | 'Manual';
}

@Injectable()
export class TradingAnalyticsService {
  private dailyStats = this.initDailyStats();

  constructor(
    private readonly telegramService: TelegramService,

    private readonly configService: ConfigService,
  ) {}

  public initDailyStats() {
    return {
      date: new Date().toISOString().split('T')[0],
      totalOrders: 0,
      profitable: 0,
      loss: 0,
      totalProfit: 0,
      positions: [] as TradePosition[],
    };
  }

  public async processClosedPosition(position: TradePosition) {
    // Обновляем статистику
    this.dailyStats.totalOrders++;
    this.dailyStats.totalProfit += position.pnl;

    if (position.pnl >= 0) {
      this.dailyStats.profitable++;
    } else {
      this.dailyStats.loss++;
    }

    this.dailyStats.positions.push(position);

    // Отправляем уведомление
    await this.sendPositionNotification(position);
  }

  private async sendPositionNotification(position: TradePosition) {
    const isProfit = position.pnl >= 0;
    const typeMap = {
      TP: { emoji: '💰', text: 'Тейк-профит' },
      SL: { emoji: '⚠️', text: 'Стоп-лосс' },
      Manual: { emoji: '✋', text: 'Вручную' },
    };

    const typeInfo = typeMap[position.closedType] || typeMap.Manual;

    const message = this.buildPositionMessage(position, typeInfo, isProfit);

    const chatId = this.configService.getOrThrow('RECIVER_TELEGRAM_ID');
    await this.telegramService.sendMessage(chatId, message);
  }

  private buildPositionMessage(
    position: TradePosition,
    typeInfo: any,
    isProfit: boolean,
  ) {
    return (
      `<b>${typeInfo.emoji} ${typeInfo.text}</b>\n` +
      `▸ Символ: <b>${position.symbol}</b>\n` +
      `▸ Сторона: <b>${position.side === 'Buy' ? 'Лонг' : 'Шорт'}</b>\n` +
      `▸ Вход: <b>${position.entryPrice.toFixed(2)}</b>\n` +
      `▸ Выход: <b>${position.exitPrice.toFixed(2)}</b>\n` +
      `▸ PnL: <b>${position.pnl.toFixed(2)} $</b> ${isProfit ? '🟢' : '🔴'}\n\n` +
      this.getDailyStats()
    );
  }

  public getDailyStats(): string {
    const winRate =
      this.dailyStats.totalOrders > 0
        ? (
            (this.dailyStats.profitable / this.dailyStats.totalOrders) *
            100
          ).toFixed(2)
        : '0.00';

    return (
      `<b>📊 Статистика за ${this.dailyStats.date}</b>\n` +
      `▸ Ордеров: <b>${this.dailyStats.totalOrders}</b>\n` +
      `▸ Прибыльных: <b>${this.dailyStats.profitable}</b>\n` +
      `▸ Убыточных: <b>${this.dailyStats.loss}</b>\n` +
      `▸ Винрейт: <b>${winRate}%</b>\n` +
      `▸ Общий PnL: <b>${this.dailyStats.totalProfit.toFixed(2)} $</b>`
    );
  }
}
