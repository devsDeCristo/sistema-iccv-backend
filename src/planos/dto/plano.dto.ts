import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PlanoDto {
  @ApiProperty({ example: 'Completo' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  /** Os módulos que o plano libera; lista vazia não libera nenhum */
  @ApiProperty({ enum: ChurchModule, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsEnum(ChurchModule, { each: true })
  modules: ChurchModule[];
}
