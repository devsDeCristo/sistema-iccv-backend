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
import { EventDto, roleEventDto } from './dto/event.dto';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES, ADMIN_ROLES } from 'src/auth/roles';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Roles(...ADMIN_ROLES)
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'logoFile', maxCount: 1 },
      { name: 'coverFile', maxCount: 1 },
    ]),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create event' })
  create(
    @UploadedFiles()
    files: {
      logoFile?: Express.Multer.File[];
      coverFile?: Express.Multer.File[];
    },
    @Body() EventDto: EventDto,
  ) {
    const logoFile = files.logoFile?.[0];
    const coverFile = files.coverFile?.[0];
    EventDto.logoFile = logoFile;
    EventDto.coverFile = coverFile;
    return this.eventService.create(EventDto);
  }

  @Get()
  @ApiOperation({ summary: 'All events' })
  async findAll(@Query() filters: Partial<EventDto>, @Req() req: any) {
    const events = await this.eventService.findAll(filters, req.user?.userId);
    return events;
  }
  @ApiOperation({ summary: 'Get insights events' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get('insights')
  findInsightsEvents() {
    return this.eventService.findInsightsEvents();
  }

  @ApiOperation({ summary: 'Event by id' })
  @ApiConsumes('multipart/form-data')
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.eventService.findOne(id, req.user?.userId);
  }

  @ApiOperation({ summary: 'Edit event' })
  @Roles(...ADMIN_ROLES)
  @Put(':id')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'logoFile', maxCount: 1 },
        { name: 'coverFile', maxCount: 1 },
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
    },
    @Param('id') id: string,
    @Body() updateEventDto: EventDto,
  ) {
    const logoFile = files.logoFile?.[0];
    const coverFile = files.coverFile?.[0];
    updateEventDto.logoFile = logoFile;
    updateEventDto.coverFile = coverFile;
    return this.eventService.update(id, updateEventDto);
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

  @ApiOperation({ summary: 'Delete event' })
  @Roles(...ADMIN_ROLES)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
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
      { requesterId: req.user?.userId },
    );
  }
  //remove o usuario do waitlist
  @ApiOperation({ summary: 'Remove user from waitlist' })
  @Roles(...ADMIN_ROLES)
  @Delete(':idEvent/waitlist/users/:idUser/rule/:roleRegistrationId')
  removeUserFromEventWaitlist(
    @Param('idEvent') idEvent: string,
    @Param('idUser') idUser: string,
    @Param('roleRegistrationId') roleRegistrationId: string,
  ) {
    return this.eventService.removeUserFromEventWaitlist(
      idUser,
      idEvent,
      roleRegistrationId,
    );
  }
}
