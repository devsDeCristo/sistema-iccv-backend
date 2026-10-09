import { ApiProperty } from '@nestjs/swagger';
import { NewsScheduleKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Um agendamento de disparo. A regra fina (data futura, dia da semana de 0 a
 * 6, horário HH:mm) fica em `validarAgendamento`, que dá a mensagem certa para
 * cada caso.
 */
export class NewsScheduleDto {
  @ApiProperty({ enum: NewsScheduleKind, example: 'WEEKLY' })
  @IsEnum(NewsScheduleKind)
  kind: NewsScheduleKind;

  @ApiProperty({
    description: '`ONCE`: momento do disparo (ISO)',
    required: false,
    example: '2026-10-09T19:00:00-03:00',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  runAt?: Date;

  @ApiProperty({
    description: '`WEEKLY`: dias da semana, 0 = domingo … 6 = sábado',
    required: false,
    example: [2],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  weekdays?: number[];

  @ApiProperty({
    description: '`WEEKLY`: horário "HH:mm", no horário de Brasília',
    required: false,
    example: '12:00',
  })
  @IsOptional()
  @IsString()
  time?: string;
}

export class SaveNewsSchedulesDto {
  @ApiProperty({ type: [NewsScheduleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewsScheduleDto)
  schedules: NewsScheduleDto[];
}
