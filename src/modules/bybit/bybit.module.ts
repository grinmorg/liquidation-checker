import { Module } from '@nestjs/common';
import { BybitService } from './bybit.service';
import { BybitController } from './bybit.controller';

@Module({
  controllers: [BybitController],
  providers: [BybitService],
})
export class BybitModule {}
