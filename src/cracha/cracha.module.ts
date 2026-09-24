import { Module } from '@nestjs/common';
import { CrachaController } from './cracha.controller';
import { CrachaService } from './cracha.service';

@Module({
  controllers: [CrachaController],
  providers: [CrachaService],
})
export class CrachaModule {}
