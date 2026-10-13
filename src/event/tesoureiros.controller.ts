import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChurchModule, EventTreasurerKind } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { ADMIN_AREA_ROLES, ADMIN_ROLES } from 'src/auth/roles';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { PrismaService } from 'src/prisma';
import { MailService } from 'src/mail/mail.service';
import { avisarAcessoAoEvento } from './aviso-de-acesso';

class SalvarTesoureiroDto {
  @IsEnum(EventTreasurerKind)
  kind: EventTreasurerKind;
}

/**
 * Os tesoureiros(as) de um evento (`EventTreasurer`): quem cuida da
 * tesouraria deste evento sem ser admin nem tesouraria da igreja. Quem dá e
 * tira o vínculo é o admin da igreja do evento; a tesouraria da igreja só vê.
 * O recorte por igreja é do `EventTenantGuard`.
 */
@ApiTags('tesoureiros do evento')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard, ModuloGuard)
@Modulo(ChurchModule.EVENTS)
@Controller('events/:idEvent/tesoureiros')
export class TesoureirosController {
  private readonly logger = new Logger(TesoureirosController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  @ApiOperation({ summary: 'Tesoureiros(as) do evento' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get()
  async listar(@Param('idEvent') eventId: string) {
    const vinculos = await this.prisma.eventTreasurer.findMany({
      where: { eventId },
      select: {
        kind: true,
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            profilePhotoUrl: true,
          },
        },
      },
      orderBy: { user: { fullName: 'asc' } },
    });
    return vinculos.map(({ kind, user }) => ({ ...user, kind }));
  }

  @ApiOperation({
    summary: 'Torna a pessoa tesoureira do evento, ou muda o tipo',
  })
  @Roles(...ADMIN_ROLES)
  @Put(':userId')
  async salvar(
    @Param('idEvent') eventId: string,
    @Param('userId') userId: string,
    @Body() { kind }: SalvarTesoureiroDto,
    @Req() req: any,
  ) {
    // qualquer perfil entra: o vínculo só soma, e vale o maior. E a recusa
    // não diria o perfil de ninguém
    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada');

    const antes = await this.prisma.eventTreasurer.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { kind: true },
    });
    await this.prisma.eventTreasurer.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, kind, createdById: req.user?.userId },
      update: { kind },
    });

    // e-mail para quem entrou agora, ou trocou de tipo — sem esperar
    if (antes?.kind !== kind) {
      avisarAcessoAoEvento(this.prisma, this.mail, eventId, [
        { userId, papel: kind, mudou: !!antes },
      ]).catch((erro) =>
        this.logger.error(`Aviso ao tesoureiro: ${(erro as Error).message}`),
      );
    }
    return this.listar(eventId);
  }

  @ApiOperation({ summary: 'Tira o vínculo de tesoureiro(a) do evento' })
  @Roles(...ADMIN_ROLES)
  @Delete(':userId')
  async remover(
    @Param('idEvent') eventId: string,
    @Param('userId') userId: string,
  ) {
    await this.prisma.eventTreasurer.deleteMany({ where: { eventId, userId } });
    return this.listar(eventId);
  }
}
