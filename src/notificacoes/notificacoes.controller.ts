import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { NotificacoesService } from './notificacoes.service';
import { MarcarLidasDto } from './notificacoes.dto';

/** Qualquer pessoa logada: o que cada um recebe o service decide pelo banco */
@ApiTags('notificacoes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notificacoes')
export class NotificacoesController {
  constructor(private readonly service: NotificacoesService) {}

  @ApiOperation({ summary: 'As notificações de quem está logado' })
  @Get()
  listar(@Req() req: any) {
    return this.service.listar(req.user.userId);
  }

  @ApiOperation({ summary: 'Quantas notificações não lidas' })
  @Get('nao-lidas')
  contarNaoLidas(@Req() req: any) {
    return this.service.contarNaoLidas(req.user.userId);
  }

  @ApiOperation({ summary: 'Marca notificações como lidas' })
  @Post('lidas')
  @HttpCode(204)
  async marcarLidas(@Req() req: any, @Body() dto: MarcarLidasDto) {
    await this.service.marcarLidas(req.user.userId, dto.ids);
  }
}
