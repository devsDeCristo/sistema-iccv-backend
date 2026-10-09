import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { NewsService } from './news.service';
import { NewsDto } from './dto/news.dto';
import { SaveNewsSchedulesDto } from './dto/news-schedule.dto';

const IMAGEM = FileFieldsInterceptor([{ name: 'imageFile', maxCount: 1 }]);

@ApiTags('news')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  /**
   * Feed de quem está logado. Rota sem `@Roles`, aberta a qualquer usuário
   * autenticado, e por isso devolve somente notícia publicada.
   */
  @Get()
  @ApiOperation({ summary: 'Notícias publicadas' })
  findPublished(
    @Req() req: { user?: { userId?: string } },
    @Query('take') take?: string,
  ) {
    return this.newsService.findPublished(
      Number(take) || undefined,
      req.user?.userId,
    );
  }

  /**
   * Lista do admin, com rascunho.
   *
   * É rota separada de propósito: o rascunho só pode sair por uma rota com
   * `@Roles`, porque é o `RolesGuard` que confere o perfil no banco — o perfil
   * que vem no token pode estar defasado por até 24h.
   */
  @Get('admin')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: 'Todas as notícias, inclusive rascunhos' })
  findAll(
    @Req() req: { user?: { userId?: string } },
    // a igreja do seletor da tela; sem ela, todas as que a pessoa alcança
    @Query('churchId') churchId?: string,
  ) {
    return this.newsService.findAll(req.user?.userId, churchId || undefined);
  }

  /**
   * Grupos que podem receber disparo — só os que têm link, de eventos no ar.
   * É a lista que o formulário de notícia oferece.
   */
  @Get('whatsapp-groups')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: 'Grupos disponíveis para disparo' })
  findWhatsappGroups(@Req() req: { user?: { userId?: string } }) {
    return this.newsService.findWhatsappGroups(req.user?.userId);
  }

  /**
   * Calendário de disparos: os feitos (histórico) e os agendados (próximas
   * ocorrências) no período `from`–`to`, em ISO. Até 62 dias.
   */
  @Get('calendar')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: 'Disparos feitos e agendados no período' })
  calendar(
    @Req() req: { user?: { userId?: string } },
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('churchId') churchId?: string,
  ) {
    return this.newsService.calendar(
      new Date(from),
      new Date(to),
      req.user?.userId,
      churchId || undefined,
    );
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @UseInterceptors(IMAGEM)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Criar notícia' })
  create(
    @Req() req: { user?: { userId?: string } },
    @UploadedFiles() files: { imageFile?: Express.Multer.File[] },
    @Body() newsDto: NewsDto,
  ) {
    newsDto.imageFile = files?.imageFile?.[0];

    return this.newsService.create(newsDto, req.user?.userId);
  }

  @Put(':id')
  @Roles(...ADMIN_ROLES)
  @UseInterceptors(IMAGEM)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Editar notícia' })
  update(
    @Param('id') id: string,
    @Req() req: { user?: { userId?: string } },
    @UploadedFiles() files: { imageFile?: Express.Multer.File[] },
    @Body() newsDto: NewsDto,
  ) {
    newsDto.imageFile = files?.imageFile?.[0];

    return this.newsService.update(id, newsDto, req.user?.userId);
  }

  /**
   * Reenvio manual. Publicar já dispara sozinho; esta rota manda de novo para
   * todos os grupos marcados, com o texto e a imagem que a notícia tem agora —
   * é a saída tanto para o que falhou quanto para a notícia corrigida depois de
   * publicada.
   */
  @Post(':id/whatsapp')
  @Roles(...ADMIN_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenviar a notícia nos grupos dos eventos' })
  resendToWhatsapp(
    @Param('id') id: string,
    @Req() req: { user?: { userId?: string } },
  ) {
    return this.newsService.resendToWhatsapp(id, req.user?.userId);
  }

  /**
   * Agendamentos de disparo da notícia: a lista enviada substitui a atual, e
   * lista vazia cancela todos. Na hora marcada, a notícia vai para todos os
   * grupos marcados, como no reenvio manual.
   */
  @Put(':id/schedules')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: 'Agendar disparos da notícia no WhatsApp' })
  saveSchedules(
    @Param('id') id: string,
    @Req() req: { user?: { userId?: string } },
    @Body() body: SaveNewsSchedulesDto,
  ) {
    return this.newsService.saveSchedules(id, body.schedules, req.user?.userId);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @HttpCode(204)
  @ApiOperation({ summary: 'Excluir notícia' })
  remove(@Param('id') id: string, @Req() req: { user?: { userId?: string } }) {
    return this.newsService.remove(id, req.user?.userId);
  }
}
