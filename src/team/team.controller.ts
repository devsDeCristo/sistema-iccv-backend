import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Put,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { TeamService } from './team.service';
import { TeammDto } from './dto/team.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';

@ApiTags('team')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('events/:idEvent/teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Post()
  @HttpCode(204)
  async create(
    @Param('idEvent') idEvent: string,
    @Body() createTeammDto: TeammDto,
  ) {
    return await this.teamService.create(idEvent, createTeammDto);
  }

  @Get()
  async findAll(@Param('idEvent') idEvent: string) {
    return this.teamService.findAll(idEvent);
  }

  @Get(':idTeam')
  findOne(@Param('idEvent') idEvent: string, @Param('idTeam') idTeam: string) {
    return this.teamService.findOne(idTeam, idEvent);
  }

  @Put(':idTeam')
  @HttpCode(204)
  update(
    @Param('idEvent') idEvent: string,
    @Param('idTeam') idTeam: string,
    @Body() updateTeammDto: TeammDto,
  ) {
    return this.teamService.update(idEvent, idTeam, updateTeammDto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('idEvent') idEvent: string, @Param('id') id: string) {
    return this.teamService.delete(id, idEvent);
  }
}
