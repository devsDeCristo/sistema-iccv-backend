import { Module } from '@nestjs/common';
import { ChurchService } from './church.service';
import { ChurchController } from './church.controller';
import { ChurchPublicController } from './church-public.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Module({
  controllers: [ChurchController, ChurchPublicController],
  providers: [ChurchService, PrismaService],
})
export class ChurchModule {}
