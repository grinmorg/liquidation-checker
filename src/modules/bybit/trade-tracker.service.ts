// src/trading/trade-tracker.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { TradingAnalyticsService } from './trading-analytics.service';
import { ConfigService } from '@nestjs/config';
import { RestClientV5 } from 'bybit-api';
import { TradePosition } from './trading-analytics.service';

export interface TrackedPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  size: number;
  openedAt: number;
}

@Injectable()
export class TradeTrackerService implements OnModuleInit {
  private activePositions: TrackedPosition[] = [];
  private readonly bybitClient: RestClientV5;
  private readonly checkInterval: number = 15000; // 15 секунд

  constructor(
    private readonly configService: ConfigService,
    private readonly analyticsService: TradingAnalyticsService,
  ) {
    this.bybitClient = new RestClientV5({
      baseUrl: 'https://api-demo.bybit.com',
      key: this.configService.getOrThrow('BYBIT_API_KEY_PUBLIC'),
      secret: this.configService.getOrThrow('BYBIT_API_KEY_SECRET'),
      testnet: false,
    });
  }

  onModuleInit() {
    this.startPositionMonitoring();
  }

  public trackNewPosition(position: TrackedPosition) {
    this.activePositions.push(position);
    console.log(`Tracking new position: ${position.symbol} ${position.side}`);
  }

  private startPositionMonitoring() {
    setInterval(() => this.checkPositions(), this.checkInterval);
  }

  private async checkPositions() {
    for (const position of [...this.activePositions]) {
      try {
        const currentPosition = await this.bybitClient.getPositionInfo({
          category: 'linear',
          symbol: position.symbol,
        });

        const posData = currentPosition.result?.list?.[0];

        if (!posData || parseFloat(posData.size) === 0) {
          await this.processClosedPosition(position);
          this.activePositions = this.activePositions.filter(
            (p) => p !== position,
          );
        }
      } catch (error) {
        console.error('Error checking position:', error);
      }
    }
  }

  private async processClosedPosition(position: TrackedPosition) {
    try {
      const ticker = await this.bybitClient.getTickers({
        category: 'linear',
        symbol: position.symbol,
      });

      const exitPrice = parseFloat(ticker.result.list[0].markPrice);
      const closedType = this.determineClosedType(position, exitPrice);
      const pnl = this.calculatePnl(position, exitPrice);

      const tradePosition: TradePosition = {
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: exitPrice,
        pnl: pnl,
        timestamp: Date.now(),
        closedType: closedType,
      };

      await this.analyticsService.processClosedPosition(tradePosition);
    } catch (error) {
      console.error('Error processing closed position:', error);
    }
  }

  private determineClosedType(
    position: TrackedPosition,
    exitPrice: number,
  ): 'TP' | 'SL' | 'Manual' {
    if (position.side === 'Buy') {
      return exitPrice >= position.takeProfit
        ? 'TP'
        : exitPrice <= position.stopLoss
          ? 'SL'
          : 'Manual';
    }
    return exitPrice <= position.takeProfit
      ? 'TP'
      : exitPrice >= position.stopLoss
        ? 'SL'
        : 'Manual';
  }

  private calculatePnl(position: TrackedPosition, exitPrice: number): number {
    const priceDifference =
      position.side === 'Buy'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;

    return priceDifference * position.size;
  }
}
