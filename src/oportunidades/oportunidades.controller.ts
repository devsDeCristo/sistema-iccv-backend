import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { OportunidadesService } from './oportunidades.service';
import {
  AtualizarOportunidadeDto,
  CriarOportunidadeDto,
} from './oportunidades.dto';
import { LIMITES } from './formulario';

/**
 * O lado do membro: qualquer pessoa logada chega, mas o service só responde a
 * quem é membro de uma igreja com o módulo — e só com as vagas dela.
 */
@ApiTags('oportunidades')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('oportunidades')
export class OportunidadesController {
  constructor(private readonly service: OportunidadesService) {}

  @ApiOperation({
    summary:
      'As vagas da igreja de que a pessoa é membro (recebendo candidatura, e as encerradas em que se candidatou)',
  })
  @Get()
  abertas(@Req() req: any) {
    return this.service.abertas(req.user.userId);
  }

  @ApiOperation({
    summary: 'A vaga com o formulário de candidatura e a candidatura da pessoa',
  })
  @Get(':id')
  detalhe(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.detalhe(req.user.userId, id);
  }

  @ApiOperation({
    summary:
      'Candidata-se: `respostas` (JSON, por id do campo) e `curriculo` (PDF), ambos opcionais conforme o formulário',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(
    FileInterceptor('curriculo', {
      limits: { fileSize: LIMITES.curriculoBytes },
    }),
  )
  @Post(':id/interesse')
  interessar(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('respostas') respostas?: string,
    @UploadedFile() curriculo?: Express.Multer.File,
  ) {
    return this.service.interessar(req.user.userId, id, respostas, curriculo);
  }

  @ApiOperation({ summary: 'Retira a candidatura (e o currículo)' })
  @Delete(':id/interesse')
  desinteressar(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.desinteressar(req.user.userId, id);
  }
}

/**
 * O lado da igreja: só o admin dela (`ChurchTenantGuard` cobra o perfil
 * **nesta** igreja; a tesouraria não publica vaga), com Oportunidades no plano.
 */
@ApiTags('oportunidades')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard, ModuloGuard)
@Roles(...ADMIN_ROLES)
@Modulo(ChurchModule.OPPORTUNITIES)
@Controller('churches/:churchId/oportunidades')
export class OportunidadesDaIgrejaController {
  constructor(private readonly service: OportunidadesService) {}

  @ApiOperation({ summary: 'As vagas da igreja, com as candidaturas' })
  @Get()
  listar(@Param('churchId') churchId: string) {
    return this.service.daIgreja(churchId);
  }

  @ApiOperation({ summary: 'Publica uma vaga aos membros' })
  @Post()
  criar(
    @Param('churchId') churchId: string,
    @Body() dto: CriarOportunidadeDto,
    @Req() req: any,
  ) {
    return this.service.criar(churchId, req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Edita, encerra ou reabre a vaga' })
  @Put(':id')
  atualizar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarOportunidadeDto,
    @Req() req: any,
  ) {
    return this.service.atualizar(churchId, id, dto, req.user.userId);
  }

  @ApiOperation({
    summary:
      'Troca a imagem da vaga (a logo); `cor` (#rrggbb, opcional) é a cor dominante dela',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('imagem', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @Put(':id/imagem')
  trocarImagem(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() imagem: Express.Multer.File,
    @Body('cor') cor?: string,
  ) {
    return this.service.trocarImagem(churchId, id, imagem, cor);
  }

  @ApiOperation({ summary: 'Remove a imagem da vaga' })
  @Delete(':id/imagem')
  removerImagem(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.removerImagem(churchId, id);
  }

  @ApiOperation({ summary: 'O currículo (PDF) de um candidato' })
  @Get(':id/interessados/:userId/curriculo')
  async curriculo(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const { arquivo, nome } = await this.service.curriculo(
      churchId,
      id,
      userId,
    );
    return new StreamableFile(arquivo, {
      type: 'application/pdf',
      disposition: `attachment; filename="curriculo.pdf"; filename*=UTF-8''${encodeURIComponent(
        nome,
      )}`,
    });
  }

  @ApiOperation({
    summary: 'Exclui a vaga, as candidaturas e os arquivos delas',
  })
  @Delete(':id')
  excluir(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.excluir(churchId, id);
  }
}
