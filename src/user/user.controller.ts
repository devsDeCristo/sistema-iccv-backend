import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Query,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserDTO } from './dto/user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserService } from './user.service';
import { uploadImageFirebase } from 'src/utils/uploadImgFirebase';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { EventService } from 'src/event/event.service';

/** Foto de perfil: imagem comum de câmera ou celular, e nada mais */
const TIPOS_DE_FOTO = ['image/jpeg', 'image/png', 'image/webp'];
const FOTO_MAXIMA_BYTES = 5 * 1024 * 1024;

function conferirFoto(file?: Express.Multer.File) {
  if (!file) {
    throw new BadRequestException('Envie uma foto');
  }
  if (!TIPOS_DE_FOTO.includes(file.mimetype)) {
    throw new BadRequestException('A foto precisa ser JPG, PNG ou WebP');
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly eventService: EventService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create user' })
  async create(@Body() data: UserDTO, @Req() req: any) {
    return this.userService.create(data, {
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }
  // riando somente no evento
  // @ApiOperation({ summary: 'Create relation user event' })
  // @Post(':idUser/event/:idEvent')
  // @UseGuards(JwtAuthGuard)
  // async createRelationEvent(
  //   @Param('idUser') idUser: string,
  //   @Param('idEvent') idEvent: string,
  //   @Body('registrationRoleId') registrationRoleId: string[],
  // ) {
  //   return this.eventService.registerUserInEvent(
  //     idUser,
  //     idEvent,
  //     registrationRoleId,
  //   );
  // }

  @ApiOperation({ summary: 'All users' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get()
  async findAll(@Query() filters: Partial<UserDTO>, @Req() req: any) {
    const users = await this.userService.findAll(filters, req.user?.userId);
    return users;
  }

  @ApiOperation({ summary: 'Get insights users' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get('insights')
  async findInsightsEvents(@Req() req: any) {
    return this.userService.findInsightsEvents(req.user?.userId);
  }

  @ApiOperation({ summary: 'User by id' })
  /**
   * O próprio cadastro, para a tela de perfil. O id vem sempre do token: não há
   * parâmetro na rota que alguém troque para ler ou editar outra pessoa.
   *
   * Declaradas antes das rotas `:id` de propósito — depois delas o Nest casaria
   * "me" como se fosse um id.
   */
  @ApiOperation({ summary: 'O próprio cadastro' })
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async findMe(@Req() req: any) {
    return this.userService.findOne(req.user.userId, req.user.userId);
  }

  @ApiOperation({ summary: 'Edita o próprio cadastro' })
  @UseGuards(JwtAuthGuard)
  @Put('me')
  async updateMe(@Body() dto: UpdateMeDto, @Req() req: any) {
    return this.userService.updateMe(req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Troca a própria foto de perfil' })
  @ApiConsumes('multipart/form-data')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: FOTO_MAXIMA_BYTES } }),
  )
  @Post('me/profile-photo')
  async setMyProfilePhoto(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    conferirFoto(file);
    const { url } = await uploadImageFirebase(file, file.originalname);
    await this.userService.setProfilePhoto(
      req.user.userId,
      url,
      req.user.userId,
    );
    return { message: 'Foto de perfil atualizada com sucesso' };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: any) {
    return this.userService.findOne(id, req.user?.userId);
  }

  @ApiOperation({ summary: 'Get Groups by user ' })
  @UseGuards(JwtAuthGuard)
  @Get(':id/groups')
  async findUserGroups(@Param('id') id: string, @Req() req: any) {
    return this.userService.findUserGroups(id, req.user?.userId);
  }

  @ApiOperation({ summary: 'Edit user' })
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: UserDTO,
    @Req() req: any,
  ) {
    return this.userService.update(id, data, req.user?.userId);
  }

  @ApiOperation({ summary: 'Edit user' })
  @Post(':id/profile-photo')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Arquivo de foto de perfil do usuário',
    type: 'file',
  })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: FOTO_MAXIMA_BYTES } }),
  )
  async setProfilePhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    // antes do upload: conferindo só depois, qualquer autenticado subia arquivo
    // para o storage com o id de outra pessoa e só então levava o 403
    conferirFoto(file);
    await this.userService.assertPodeTrocarFoto(req.user?.userId, id);

    // reaproveita o util para não duplicar o cacheControl e o versionamento da URL
    const { url } = await uploadImageFirebase(file, file.originalname);

    await this.userService.setProfilePhoto(id, url, req.user?.userId);
    return { message: 'Foto de perfil atualizada com sucesso' };
  }
}
