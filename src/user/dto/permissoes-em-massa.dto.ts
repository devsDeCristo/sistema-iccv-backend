import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  ValidateIf,
} from 'class-validator';
import { CHURCH_ROLES } from 'src/auth/roles';

/** Teto de pessoas por pedido: mais que isso é engano, ou script */
export const MAXIMO_EM_MASSA = 200;

/**
 * O mesmo perfil, numa igreja, para várias pessoas de uma vez.
 * `role: null` tira o perfil delas naquela igreja.
 */
export class PermissoesEmMassaDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_EM_MASSA)
  @IsString({ each: true })
  userIds: string[];

  @ApiProperty()
  @IsString()
  churchId: string;

  @ApiProperty({
    nullable: true,
    description: 'Admin (2) ou financeiro (3); null tira o perfil na igreja',
  })
  @ValidateIf((dto) => dto.role !== null)
  @IsIn(CHURCH_ROLES)
  role: number | null;
}
