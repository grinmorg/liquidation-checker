import { Controller } from '@nestjs/common';
import { BybitService } from './bybit.service';

@Controller('bybit')
export class BybitController {
  constructor(private readonly bybitService: BybitService) {}
}
