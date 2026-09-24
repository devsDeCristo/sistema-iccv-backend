import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { QuadranteService } from './quadrante.service';

/**
 * Sem `@Roles` nem `EventTenantGuard`: além do admin da igreja, o inscrito
 * também abre o quadrante quando o evento libera. Quem pode ver é decidido em
 * `QuadranteService.assertPodeVer`, em toda rota daqui.
 */
@ApiTags('quadrante')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events/:idEvent/quadrante')
export class QuadranteController {
  constructor(private readonly quadranteService: QuadranteService) {}

  @Get()
  async findOne(@Param('idEvent') idEvent: string, @Req() req) {
    await this.quadranteService.assertPodeVer(idEvent, req.user?.userId);
    const quadrante = await this.quadranteService.findQuadrante(idEvent);

    // quem abre a tela quase sempre baixa o PDF em seguida: as fotos começam a
    // chegar agora, sem atrasar esta resposta
    this.quadranteService.aquecerImagens(quadrante);

    return quadrante;
  }

  @Get('pdf')
  async generatePdf(
    @Param('idEvent') idEvent: string,
    @Req() req,
    @Res() res: Response,
  ) {
    await this.quadranteService.assertPodeVer(idEvent, req.user?.userId);

    const { buffer, fileName } =
      await this.quadranteService.generatePdf(idEvent);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    res.send(buffer);
  }
}
