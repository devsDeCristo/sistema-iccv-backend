import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Put,
  Query,
  Req,
  UseGuards,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { EventService } from './event.service';
import {
  EventDto,
  ProductPurchaseDto,
  GuardianApprovalDto,
  roleEventDto,
} from './dto/event.dto';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES, ADMIN_ROLES, Role } from 'src/auth/roles';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Roles(...ADMIN_ROLES)
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'logoFile', maxCount: 1 },
        { name: 'coverFile', maxCount: 1 },
        { name: 'termFile', maxCount: 1 },
      ],
      {
        // os produtos chegam como JSON num campo de texto, com as fotos em
        // base64 dentro; o padrão do multer é 1 MB por campo, e poucas fotos
        // já passam disso
        limits: { fieldSize: 20 * 1024 * 1024 },
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create event' })
  create(
    @UploadedFiles()
    files: {
      logoFile?: Express.Multer.File[];
      coverFile?: Express.Multer.File[];
      termFile?: Express.Multer.File[];
    },
    @Body() EventDto: EventDto,
    @Req() req: any,
  ) {
    const logoFile = files.logoFile?.[0];
    const coverFile = files.coverFile?.[0];
    const termFile = files.termFile?.[0];
    EventDto.logoFile = logoFile;
    EventDto.coverFile = coverFile;
    EventDto.termFile = termFile;
    return this.eventService.create(EventDto, req.user?.userId);
  }

  /**
   * `painel=true` é a lista do administrador, recortada pela igreja dele. Sem o
   * parâmetro vem o catálogo — o que a área do usuário mostra para qualquer um
   * que esteja logado, admin inclusive.
   */
  @Get()
  @ApiOperation({ summary: 'All events' })
  async findAll(
    @Query() filters: Partial<EventDto>,
    @Query('painel') painel: string,
    @Req() req: any,
  ) {
    const events = await this.eventService.findAll(
      filters,
      req.user?.userId,
      painel === 'true',
    );
    return events;
  }
  @ApiOperation({ summary: 'Get insights events' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get('insights')
  findInsightsEvents(@Req() req: any) {
    return this.eventService.findInsightsEvents(req.user?.userId);
  }

  @ApiOperation({ summary: 'Event by id' })
  @ApiQuery({
    name: 'embedImages',
    required: false,
    description:
      'Inclui logo e capa em base64 (data.logoBase64/data.coverBase64). ' +
      'Só para geração de PDF: deixa a resposta ~1,5s mais lenta.',
  })
  @ApiConsumes('multipart/form-data')
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Query('embedImages') embedImages: string,
    @Query('painel') painel: string,
    @Req() req: any,
  ) {
    return this.eventService.findOne(id, req.user?.userId, {
      embedImages: embedImages === 'true' || embedImages === '1',
      emPainel: painel === 'true',
    });
  }

  @ApiOperation({ summary: 'Edit event' })
  /**
   * `:idEvent` e não `:id`: é por este nome que o `EventTenantGuard` acha o
   * evento na URL. Com `:id` ele não resolvia nada e liberava a rota, e a
   * checagem de igreja ficava só dentro do serviço — que a faz, mas aí a
   * garantia depende de cada método lembrar dela.
   */
  @Roles(...ADMIN_ROLES)
  @Put(':idEvent')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'logoFile', maxCount: 1 },
        { name: 'coverFile', maxCount: 1 },
        { name: 'termFile', maxCount: 1 },
      ],
      {
        limits: {
          fieldSize: 100 * 1024 * 1024, // Limite de tamanho do arquivo para 50MB
        },
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  update(
    @UploadedFiles()
    files: {
      logoFile?: Express.Multer.File[];
      coverFile?: Express.Multer.File[];
      termFile?: Express.Multer.File[];
    },
    @Param('idEvent') id: string,
    @Body() updateEventDto: EventDto,
    @Req() req: any,
  ) {
    const logoFile = files.logoFile?.[0];
    const coverFile = files.coverFile?.[0];
    const termFile = files.termFile?.[0];
    updateEventDto.logoFile = logoFile;
    updateEventDto.coverFile = coverFile;
    updateEventDto.termFile = termFile;
    return this.eventService.update(id, updateEventDto, req.user?.userId);
  }

  @ApiOperation({ summary: 'Get users by event' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get(':idEvent/users')
  async findUsers(@Param('idEvent') idEvent: string) {
    return this.eventService.findUsers(idEvent);
  }

  @ApiOperation({ summary: 'Remove user to event' })
  @Roles(...ADMIN_ROLES)
  @Delete(':idEvent/users/:idUser/rule/:roleRegistrationId')
  removeUserFromEvent(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @Param('roleRegistrationId') roleRegistrationId: string,
  ) {
    return this.eventService.removeUserFromEvent(
      idUser,
      idEvent,
      roleRegistrationId,
    );
  }

  @ApiOperation({ summary: 'Edit user in event' })
  @Roles(...ADMIN_ROLES)
  @Put(':idEvent/users/:idUser')
  updateUserFromEvent(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @Body() body: roleEventDto,
  ) {
    return this.eventService.updateUserFromEvent(
      idUser,
      idEvent,
      body.roleRegistrationId,
    );
  }

  /**
   * Apagar evento é decisão de negócio, não de operação: leva junto grupos,
   * quartos, equipes, lista de espera e o histórico de cobrança. Por isso o
   * perfil interno de desenvolvimento é o único que alcança a rota — e o
   * serviço confere de novo, lendo o perfil do banco, para que a trava não
   * dependa só do token.
   */
  @ApiOperation({
    summary: 'Delete event',
    description:
      'Apaga o evento e tudo que pende dele. Só o perfil DEV, e só enquanto o evento não tiver inscritos.',
  })
  @Roles(Role.DEV)
  @Delete(':idEvent')
  remove(@Param('idEvent') id: string, @Req() req: any) {
    return this.eventService.remove(id, req.user.userId);
  }

  @ApiOperation({ summary: 'Find users in waitlist' })
  @Roles(...ADMIN_ROLES)
  @Get(':idEvent/waitlist/users')
  findUsersInWaitlist(@Param('idEvent') idEvent: string) {
    return this.eventService.findUsersInWaitlist(idEvent);
  }

  @ApiOperation({ summary: 'Remove user from waitlist' })
  @Roles(...ADMIN_ROLES)
  @Delete(':idEvent/waitlist/users/:idUser/rule/:roleRegistrationId')
  removeUserFromWaitlist(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @Param('roleRegistrationId') roleRegistrationId: string,
  ) {
    return this.eventService.removeUserFromWaitlist(
      idUser,
      idEvent,
      roleRegistrationId,
    );
  }

  @ApiOperation({ summary: 'Move user from waitlist to event' })
  @Roles(...ADMIN_ROLES)
  @Put(':eventId/waitlist/move')
  moveUserFromWaitlistToEvent(
    @Param('eventId') eventId: string,
    @Body()
    body: {
      userFromWaitlistId: string;
      userToRemoveId: string;
      roleRegistrationId: string;
    },
  ) {
    return this.eventService.movedUserFromWaitlistToEvent(
      body.userFromWaitlistId,
      body.userToRemoveId,
      eventId,
      body.roleRegistrationId,
    );
  }

  @ApiOperation({ summary: 'Register user in event' })
  @Post(':idEvent/users/:idUser')
  async createRelationEvent(
    @Param('idUser') idUser: string,
    @Param('idEvent') idEvent: string,
    @Body() body: roleEventDto,
    @Req() req: any,
  ) {
    return this.eventService.registerUserInEvent(
      idUser,
      idEvent,
      body.roleRegistrationId,
      { requesterId: req.user?.userId, acceptedTerms: body.acceptedTerms },
    );
  }

  @ApiOperation({
    summary: 'Buy event products for a confirmed registration',
    description:
      'Chamado depois da inscrição e antes do checkout. Os itens entram no pagamento do ingresso e seguem no mesmo link de pagamento.',
  })
  @Post(':idEvent/users/:idUser/products')
  buyProducts(
    @Param('idUser') idUser: string,
    @Param('idEvent') idEvent: string,
    @Body() body: ProductPurchaseDto,
    @Req() req: any,
  ) {
    return this.eventService.comprarProdutos(idUser, idEvent, body, {
      requesterId: req.user?.userId,
    });
  }

  @ApiOperation({
    summary: 'Attach/replace the signed guardian authorization term',
  })
  @Post(':idEvent/users/:idUser/guardian-term')
  @UseInterceptors(FileFieldsInterceptor([{ name: 'termFile', maxCount: 1 }]))
  @ApiConsumes('multipart/form-data')
  async uploadGuardianTerm(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @UploadedFiles() files: { termFile?: Express.Multer.File[] },
    @Req() req: any,
  ) {
    return this.eventService.uploadGuardianTerm(
      idUser,
      idEvent,
      files.termFile?.[0],
      req.user?.userId,
    );
  }

  @ApiOperation({ summary: 'Approve or reject the guardian authorization' })
  @Roles(...ADMIN_ROLES)
  @Put(':idEvent/users/:idUser/guardian-approval')
  async reviewGuardianApproval(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @Body() body: GuardianApprovalDto,
    @Req() req: any,
  ) {
    return this.eventService.reviewGuardianApproval(
      idUser,
      idEvent,
      body,
      req.user?.userId,
    );
  }
}
