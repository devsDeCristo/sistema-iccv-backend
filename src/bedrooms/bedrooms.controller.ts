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
import { BedroomsService } from './bedrooms.service';
import { BedroomDto } from './dto/bedroom.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { EventTenantGuard } from 'src/decorators/event-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';

@ApiTags('bedrooms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('events/:idEvent/bedrooms')
export class BedroomsController {
  constructor(private readonly bedroomsService: BedroomsService) {}

  @Post()
  @HttpCode(204)
  async create(
    @Param('idEvent') idEvent: string,
    @Body() createBedroomDto: BedroomDto,
  ) {
    return await this.bedroomsService.create(idEvent, createBedroomDto);
  }

  @Get()
  async findAll(@Param('idEvent') idEvent: string) {
    return this.bedroomsService.findAll(idEvent);
  }

  @Get(':idBedrooms')
  findOne(
    @Param('idEvent') idEvent: string,
    @Param('idBedrooms') idBedrooms: string,
  ) {
    return this.bedroomsService.findOne(idBedrooms, idEvent);
  }

  @Put(':idBedrooms')
  @HttpCode(204)
  update(
    @Param('idEvent') idEvent: string,
    @Param('idBedrooms') idBedrooms: string,
    @Body() updateBedroomDto: BedroomDto,
  ) {
    return this.bedroomsService.update(idEvent, idBedrooms, updateBedroomDto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('idEvent') idEvent: string, @Param('id') id: string) {
    return this.bedroomsService.delete(id, idEvent);
  }
}
