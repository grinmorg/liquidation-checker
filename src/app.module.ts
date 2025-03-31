import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BybitModule } from './modules/bybit/bybit.module';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './modules/telegram-bot/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TelegramModule,
    BybitModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
