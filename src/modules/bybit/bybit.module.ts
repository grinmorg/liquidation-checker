import { Module } from '@nestjs/common';
import { BybitService } from './bybit.service';
import { BybitController } from './bybit.controller';
import { TradingAnalyticsService } from './trading-analytics.service';
import { TradeTrackerService } from './trade-tracker.service';

@Module({
  controllers: [BybitController],
  providers: [BybitService, TradingAnalyticsService, TradeTrackerService],
})
export class BybitModule {}
