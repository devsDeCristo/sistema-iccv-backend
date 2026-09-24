import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { RolesGuard } from 'src/decorators/roles.guard';
import { CrachaService } from './cracha.service';
import { GerarCrachasDto } from './dto/gerar-crachas.dto';

/**
 * Os mesmos perfis que abrem a lista de inscritos do evento — é dela que saem
 * os crachás. `POST` porque quem escolhe quais crachás, em que ordem e com que
 * cabeçalho é o modal, e isso vai no corpo.
 */
@ApiTags('crachas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Controller('events/:idEvent/crachas')
export class CrachaController {
  constructor(private readonly crachaService: CrachaService) {}

  @ApiOperation({ summary: 'Gera o PDF dos crachás do evento' })
  @Roles(...ADMIN_AREA_ROLES)
  @Post('pdf')
  async gerarPdf(
    @Param('idEvent') idEvent: string,
    @Body() dto: GerarCrachasDto,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.crachaService.gerarPdf(
      idEvent,
      dto,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
