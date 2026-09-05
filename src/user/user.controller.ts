import {
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
import { UserService } from './user.service';
import { uploadImageFirebase } from 'src/utils/uploadImgFirebase';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { EventService } from 'src/event/event.service';

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
  async create(@Body() data: UserDTO) {
    return this.userService.create(data);
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
  async findAll(@Query() filters: Partial<UserDTO>) {
    const users = await this.userService.findAll(filters);
    return users;
  }

  @ApiOperation({ summary: 'Get insights users' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get('insights')
  async findInsightsEvents() {
    return this.userService.findInsightsEvents();
  }

  @ApiOperation({ summary: 'User by id' })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  @ApiOperation({ summary: 'Get Groups by user ' })
  @UseGuards(JwtAuthGuard)
  @Get(':id/groups')
  async findUserGroups(@Param('id') id: string) {
    return this.userService.findUserGroups(id);
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
  @UseInterceptors(FileInterceptor('photo'))
  async setProfilePhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    // reaproveita o util para não duplicar o cacheControl e o versionamento da URL
    const { url } = await uploadImageFirebase(file, file.originalname);

    await this.userService.setProfilePhoto(id, url, req.user?.userId);
    return { message: 'Foto de perfil atualizada com sucesso' };
  }
}
