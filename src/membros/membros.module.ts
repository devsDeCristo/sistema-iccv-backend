import { Module } from '@nestjs/common';
import { MembrosController } from './membros.controller';
import { MembrosService } from './membros.service';

@Module({
  controllers: [MembrosController],
  providers: [MembrosService],
})
export class MembrosModule {}
