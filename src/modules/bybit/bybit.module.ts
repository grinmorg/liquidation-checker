import { Module } from '@nestjs/common';
import { BybitService } from './bybit.service';
import { BybitController } from './bybit.controller';
import { TradingAnalyticsService } from './trading-analytics.service';

@Module({
  controllers: [BybitController],
  providers: [BybitService, TradingAnalyticsService],
})
export class BybitModule {}
