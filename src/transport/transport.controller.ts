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
import { TransportService } from './transport.service';
import { TransportDto } from './dto/transport.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';

@ApiTags('transport')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('events/:idEvent/transport')
export class TransportController {
  constructor(private readonly transportService: TransportService) {}

  @Post()
  @HttpCode(204)
  async create(
    @Param('idEvent') idEvent: string,
    @Body() createTransportDto: TransportDto,
  ) {
    return await this.transportService.create(idEvent, createTransportDto);
  }

  @Get()
  async findAll(@Param('idEvent') idEvent: string) {
    return this.transportService.findAll(idEvent);
  }

  @Get(':idTransport')
  findOne(
    @Param('idEvent') idEvent: string,
    @Param('idTransport') idTransport: string,
  ) {
    return this.transportService.findOne(idTransport, idEvent);
  }

  @Put(':idTransport')
  @HttpCode(204)
  update(
    @Param('idEvent') idEvent: string,
    @Param('idTransport') idTransport: string,
    @Body() updateTransportDto: TransportDto,
  ) {
    return this.transportService.update(
      idEvent,
      idTransport,
      updateTransportDto,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('idEvent') idEvent: string, @Param('id') id: string) {
    return this.transportService.delete(id, idEvent);
  }
}
