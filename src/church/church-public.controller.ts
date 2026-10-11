import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChurchStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * As igrejas que aparecem para escolher na inscrição — sem login, porque a
 * inscrição é antes de haver conta. Só o nome e o id, e só as ativas: a
 * igreja em implantação ou fora do ar ainda não recebe gente.
 */
@ApiTags('churches')
@Controller('public/churches')
export class ChurchPublicController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOperation({ summary: 'Igrejas ativas, para escolher na inscrição' })
  @Get()
  listar() {
    return this.prisma.church.findMany({
      where: { status: ChurchStatus.ACTIVE },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}
