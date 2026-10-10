import { ApiProperty } from '@nestjs/swagger';
import { EventStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsString,
} from 'class-validator';

/** Teto de eventos por pedido: mais que isso é engano, ou script */
export const MAXIMO_DE_EVENTOS_EM_MASSA = 200;

/** O mesmo status para vários eventos de uma vez */
export class StatusEmMassaDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_DE_EVENTOS_EM_MASSA)
  @IsString({ each: true })
  eventIds: string[];

  @ApiProperty({ enum: EventStatus })
  @IsEnum(EventStatus)
  status: EventStatus;
}
