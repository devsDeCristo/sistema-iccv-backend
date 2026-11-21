import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  HttpCode,
  ParseUUIDPipe,
  Patch,
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
  AcompanharCandidaturaDto,
  AtualizarOportunidadeDto,
  CriarOportunidadeDto,
  RecusarPropostaDto,
} from './oportunidades.dto';
import { LIMITES } from './formulario';

/** O PDF do currículo, como download (o mesmo para o admin e quem propôs) */
const comoPdf = ({ arquivo, nome }: { arquivo: Buffer; nome: string }) =>
  new StreamableFile(arquivo, {
    type: 'application/pdf',
    disposition: `attachment; filename="curriculo.pdf"; filename*=UTF-8''${encodeURIComponent(
      nome,
    )}`,
  });

/**
 * As propostas de vaga dos membros. Como no resto do lado do membro, o
 * service só responde a quem é membro de uma igreja com o módulo, e a igreja
 * sai do cadastro, nunca da requisição.
 *
 * **Registrado antes de `OportunidadesController`** (ver o módulo): lá há
 * `GET /oportunidades/:id`, que pegaria `/oportunidades/propostas` se viesse
 * primeiro.
 */
@ApiTags('oportunidades')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('oportunidades/propostas')
export class PropostasDeOportunidadeController {
  constructor(private readonly service: OportunidadesService) {}

  @ApiOperation({
    summary:
      'As propostas da pessoa na igreja dela (a aprovada vem com os candidatos)',
  })
  @Get()
  minhas(@Req() req: any) {
    return this.service.minhasPropostas(req.user.userId);
  }

  @ApiOperation({ summary: 'Propõe uma vaga ao admin da igreja' })
  @Post()
  propor(@Req() req: any, @Body() dto: CriarOportunidadeDto) {
    return this.service.propor(req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Edita a proposta enquanto está pendente' })
  @Put(':id')
  editar(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarOportunidadeDto,
  ) {
    return this.service.editarProposta(req.user.userId, id, dto);
  }

  @ApiOperation({ summary: 'Retira a proposta enquanto está pendente' })
  @Delete(':id')
  retirar(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.retirarProposta(req.user.userId, id);
  }

  @ApiOperation({ summary: 'Troca a imagem da proposta pendente' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('imagem', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @Put(':id/imagem')
  trocarImagem(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() imagem: Express.Multer.File,
    @Body('cor') cor?: string,
  ) {
    return this.service.trocarImagemDaProposta(
      req.user.userId,
      id,
      imagem,
      cor,
    );
  }

  @ApiOperation({ summary: 'Remove a imagem da proposta pendente' })
  @Delete(':id/imagem')
  removerImagem(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.removerImagemDaProposta(req.user.userId, id);
  }

  @ApiOperation({
    summary:
      'Etapa e anotação de um candidato da vaga proposta (aprovada); o candidato não vê',
  })
  @Patch(':id/interessados/:userId')
  acompanhar(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AcompanharCandidaturaDto,
  ) {
    return this.service.acompanharNaProposta(req.user.userId, id, userId, dto);
  }

  @ApiOperation({
    summary: 'O currículo de um candidato da vaga proposta (aprovada)',
  })
  @Get(':id/interessados/:userId/curriculo')
  async curriculo(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return comoPdf(
      await this.service.curriculoDaProposta(req.user.userId, id, userId),
    );
  }
}

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

  @ApiOperation({
    summary: 'Etapa e anotação de um candidato; o candidato não vê',
  })
  @Patch(':id/interessados/:userId')
  acompanhar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AcompanharCandidaturaDto,
  ) {
    return this.service.acompanharNoPainel(churchId, id, userId, dto);
  }

  @ApiOperation({ summary: 'O currículo (PDF) de um candidato' })
  @Get(':id/interessados/:userId/curriculo')
  async curriculo(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return comoPdf(await this.service.curriculo(churchId, id, userId));
  }

  @ApiOperation({
    summary: 'Aprova a proposta de um membro: vai ao ar para os membros',
  })
  @HttpCode(200)
  @Post(':id/aprovar')
  aprovar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    return this.service.aprovar(churchId, id, req.user.userId);
  }

  @ApiOperation({
    summary: 'Recusa a proposta: fica arquivada; o motivo vai para quem propôs',
  })
  @HttpCode(200)
  @Post(':id/recusar')
  recusar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecusarPropostaDto,
    @Req() req: any,
  ) {
    return this.service.recusar(churchId, id, req.user.userId, dto.motivo);
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
