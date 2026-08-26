import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  findPublished(@Query('take') take?: string) {
    return this.newsService.findPublished(Number(take) || undefined);
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
  findAll() {
    return this.newsService.findAll();
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
    @UploadedFiles() files: { imageFile?: Express.Multer.File[] },
    @Body() newsDto: NewsDto,
  ) {
    newsDto.imageFile = files?.imageFile?.[0];

    return this.newsService.update(id, newsDto);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @HttpCode(204)
  @ApiOperation({ summary: 'Excluir notícia' })
  remove(@Param('id') id: string) {
    return this.newsService.remove(id);
  }
}
