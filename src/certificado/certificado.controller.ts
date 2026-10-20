import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import { Response } from 'express';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { AceitaAdminDoEvento } from 'src/auth/admin-do-evento';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { naFilaDaRequisicao } from 'src/pdf/fila';
import { CertificadoService } from './certificado.service';
import { CertificadosDosMarcadosDto } from './dto/configurar-certificado.dto';

const enviarPdf = (
  res: Response,
  { buffer, fileName }: { buffer: Buffer; fileName: string },
) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buffer);
};

/** O painel do evento: configurar o certificado, gerar os PDFs */
@ApiTags('certificado')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard, ModuloGuard)
@Roles(...ADMIN_ROLES)
@Modulo(ChurchModule.EVENTS)
// o admin deste evento cuida dele como o da igreja
@AceitaAdminDoEvento()
@Controller('events/:idEvent')
export class CertificadoController {
  constructor(private readonly certificadoService: CertificadoService) {}

  // a configuração é salva junto com o evento (cadastro e edição): aqui só
  // se lê, para o formulário de edição e a aba de presença
  @ApiOperation({ summary: 'Configuração do certificado de participação' })
  @Get('certificate')
  config(@Param('idEvent') idEvent: string) {
    return this.certificadoService.config(idEvent);
  }

  @ApiOperation({ summary: 'Lista de presença: inscritos, com a chegada' })
  @Get('attendance')
  presenca(@Param('idEvent') idEvent: string) {
    return this.certificadoService.presenca(idEvent);
  }

  @ApiOperation({ summary: 'Certificados dos marcados que vieram (PDF)' })
  @Post('certificates/pdf')
  async certificados(
    @Param('idEvent') idEvent: string,
    @Body() dto: CertificadosDosMarcadosDto,
    @Req() req,
    @Res() res: Response,
  ) {
    // um PDF de cada vez no servidor — ver `src/pdf/fila.ts`
    enviarPdf(
      res,
      await naFilaDaRequisicao(req, res, () =>
        this.certificadoService.pdfDosCertificados(idEvent, dto.userIds),
      ),
    );
  }
}

/**
 * O certificado da própria pessoa. Sem `@Roles`: é de qualquer inscrito, e
 * quem decide se ela tem direito é o serviço (presente, evento terminado).
 */
@ApiTags('certificado')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('events/:idEvent/certificates/me')
export class MeuCertificadoController {
  constructor(private readonly certificadoService: CertificadoService) {}

  @ApiOperation({ summary: 'O meu certificado de participação (PDF)' })
  @Get('pdf')
  async meu(
    @Param('idEvent') idEvent: string,
    @Req() req,
    @Res() res: Response,
  ) {
    enviarPdf(
      res,
      await naFilaDaRequisicao(req, res, () =>
        this.certificadoService.pdfDoMeuCertificado(idEvent, req.user.userId),
      ),
    );
  }
}

/** Pública: o QR do certificado abre a verificação sem login */
@ApiTags('certificado')
@Controller('certificates')
export class VerificacaoDeCertificadoController {
  constructor(private readonly certificadoService: CertificadoService) {}

  @ApiOperation({ summary: 'Confere um certificado pelo código' })
  @Get(':codigo')
  verificar(@Param('codigo') codigo: string) {
    return this.certificadoService.verificar(codigo);
  }
}
