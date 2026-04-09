/**
 * WordPress dependencies
 */
import { __unstableStripHTML as stripHTML, focus } from '@wordpress/dom';
import {
	Popover,
	Button,
	VisuallyHidden,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { __ } from '@wordpress/i18n';
import {
	BlockIcon,
	LinkControl,
	useBlockEditingMode,
	store as blockEditorStore,
} from '@wordpress/block-editor';
import { useSelect, useDispatch } from '@wordpress/data';
import {
	useMemo,
	useState,
	useRef,
	useEffect,
	forwardRef,
} from '@wordpress/element';
import { useResourcePermissions } from '@wordpress/core-data';
import { createBlock, store as blocksStore } from '@wordpress/blocks';
import { plus } from '@wordpress/icons';
import { useInstanceId } from '@wordpress/compose';
import { isURL } from '@wordpress/url';

/**
 * Internal dependencies
 */
import { LinkUIPageCreator } from './page-creator';
import LinkUIBlockInserter from './block-inserter';
import { useEntityBinding, useLinkPreview } from '../shared';

/**
 * Given the Link block's type attribute, return the query params to give to
 * /wp/v2/search.
 *
 * @param {string} type Link block's type attribute.
 * @param {string} kind Link block's entity of kind (post-type|taxonomy)
 * @return {{ type?: string, subtype?: string }} Search query params.
 */
export function getSuggestionsQuery( type, kind ) {
	// How many results to show initially and per search.
	const perPage = 20;

	switch ( type ) {
		case 'post':
		case 'page':
			return { type: 'post', subtype: type, perPage };
		case 'category':
			return { type: 'term', subtype: 'category', perPage };
		case 'tag':
			return { type: 'term', subtype: 'post_tag', perPage };
		case 'post_format':
			return { type: 'post-format', perPage };
		default:
			if ( kind === 'taxonomy' ) {
				return { type: 'term', subtype: type, perPage };
			}
			if ( kind === 'post-type' ) {
				return { type: 'post', subtype: type, perPage };
			}
			return {
				// for custom link which has no type
				// always show pages as initial suggestions
				initialSuggestionsSearchOptions: {
					type: 'post',
					subtype: 'page',
					perPage,
				},
			};
	}
}

function matchesSearch( values, searchValue ) {
	const normalizedSearch = searchValue.trim().toLowerCase();

	if ( ! normalizedSearch ) {
		return false;
	}

	return values
		.filter( Boolean )
		.join( ' ' )
		.toLowerCase()
		.includes( normalizedSearch );
}

function getMatchingNavigationItems( {
	allowedBlocks,
	getBlockVariations,
	searchValue,
} ) {
	if ( ! searchValue.trim() ) {
		return [];
	}

	const blockItems = ( allowedBlocks || [] )
		.filter( Boolean )
		.filter( ( blockType ) => blockType.name !== 'core/navigation-link' )
		.filter( ( blockType ) => blockType.supports?.inserter !== false )
		.filter( ( blockType ) =>
			matchesSearch(
				[
					blockType.title,
					blockType.name,
					...( blockType.keywords || [] ),
				],
				searchValue
			)
		)
		.map( ( blockType ) => ( {
			kind: 'block',
			key: blockType.name,
			title: blockType.title || blockType.name,
			icon: blockType.icon,
			blockName: blockType.name,
		} ) );

	const variationItems = (
		getBlockVariations( 'core/navigation-link' ) || []
	)
		.filter( ( variation ) =>
			matchesSearch(
				[
					variation.title,
					variation.name,
					variation.description,
					...( variation.keywords || [] ),
				],
				searchValue
			)
		)
		.map( ( variation ) => ( {
			kind: 'variation',
			key: `variation-${ variation.name }`,
			title: variation.title || variation.name,
			icon: variation.icon,
			variation,
		} ) );

	return [ ...variationItems, ...blockItems ].slice( 0, 6 );
}

function createNavigationItemFromSearchResult( item ) {
	if ( item.kind === 'variation' ) {
		const { variation } = item;

		return createBlock(
			'core/navigation-link',
			variation.attributes || {},
			variation.innerBlocks || []
		);
	}

	if ( item.blockName === 'core/navigation-submenu' ) {
		return createBlock(
			'core/navigation-submenu',
			{
				label: __( 'Submenu' ),
			},
			[ createBlock( 'core/navigation-link' ) ]
		);
	}

	return createBlock( item.blockName );
}

function LinkUIItemIcon( { icon } ) {
	if ( ! icon ) {
		return null;
	}

	return (
		<span className="link-ui-tools__block-icon">
			<BlockIcon icon={ icon } showColors={ false } />
		</span>
	);
}

function UnforwardedLinkUI( props, ref ) {
	const { label, url, opensInNewTab, type, kind, id } = props.link;

	const { entityRecord, hasBinding, isEntityAvailable } = props.entity || {};

	const { image, badges } = useLinkPreview( {
		url,
		entityRecord,
		type,
		hasBinding,
		isEntityAvailable,
	} );

	const { clientId } = props;
	const postType = type || 'page';

	const [ addingBlock, setAddingBlock ] = useState( false );
	const [ addingPage, setAddingPage ] = useState( false );
	const [ shouldFocusPane, setShouldFocusPane ] = useState( null );
	const [ searchValue, setSearchValue ] = useState( '' );
	// Stable initial value for LinkControl's uncontrolled inputValue prop.
	// We track the search with the searchInputValueRef, then update the
	// initialSearchValue state with the observed searchInputValueRef
	// when mounting the LinkControl. If LinkControl becomes a fully
	// controlled component, then we can remove this extra complexity.
	const [ initialSearchValue, setInitialSearchValue ] = useState( '' );
	// Tracks the live search input between renders without causing re-renders.
	const searchInputValueRef = useRef( '' );
	// Call this instead of setting searchInputValueRef.current and
	// setInitialSearchValue separately, to keep both in sync.
	const updateSearchValue = ( value ) => {
		searchInputValueRef.current = value;
		setInitialSearchValue( value );
		setSearchValue( value );
	};
	const linkControlWrapperRef = useRef();
	const addPageButtonRef = useRef();
	const addBlockButtonRef = useRef();
	const permissions = useResourcePermissions( {
		kind: 'postType',
		name: postType,
	} );

	// Use the entity binding hook to get binding status
	const { isBoundEntityAvailable } = useEntityBinding( {
		clientId,
		attributes: props.link,
	} );

	// Memoize link value to avoid overriding the LinkControl's internal state.
	// This is a temporary fix. See https://github.com/WordPress/gutenberg/issues/50976#issuecomment-1568226407.
	const link = useMemo(
		() => ( {
			url,
			opensInNewTab,
			title: label && stripHTML( label ),
			kind,
			type,
			id,
			image,
			badges,
		} ),
		[ label, opensInNewTab, url, kind, type, id, image, badges ]
	);

	const { replaceBlock } = useDispatch( blockEditorStore );

	const { rootBlockClientId, matchingNavigationItems } = useSelect(
		( select ) => {
			const { getBlockRootClientId, getAllowedBlocks } =
				select( blockEditorStore );
			const { getBlockVariations } = select( blocksStore );

			const parentClientId = clientId
				? getBlockRootClientId( clientId )
				: null;

			return {
				rootBlockClientId: parentClientId,
				matchingNavigationItems: getMatchingNavigationItems( {
					allowedBlocks: parentClientId
						? getAllowedBlocks( parentClientId )
						: [],
					getBlockVariations,
					searchValue,
				} ),
			};
		},
		[ clientId, searchValue ]
	);

	const handleInlineItemInsert = ( item ) => {
		if ( ! clientId || ! rootBlockClientId ) {
			return;
		}

		// In Link UI search, matched navigation items replace the current
		// navigation-link placeholder instead of inserting a sibling.
		replaceBlock( clientId, createNavigationItemFromSearchResult( item ) );
	};

	const handlePageCreated = ( pageLink ) => {
		// Set the new page as the current link
		props.onChange( pageLink );
		// Return to main Link UI and focus the first focusable element
		setAddingPage( false );
		setShouldFocusPane( true );
		// Clear search input value
		updateSearchValue( '' );
	};

	const dialogTitleId = useInstanceId(
		LinkUI,
		'link-ui-link-control__title'
	);
	const dialogDescriptionId = useInstanceId(
		LinkUI,
		'link-ui-link-control__description'
	);

	// Focus management when transitioning between panes
	useEffect( () => {
		if ( shouldFocusPane && linkControlWrapperRef.current ) {
			// If we have a specific element to focus, focus it
			if ( shouldFocusPane?.current ) {
				// Focus the specific element passed
				shouldFocusPane.current.focus();
			} else {
				// Focus the first tabbable element (keyboard-accessible, excluding tabindex="-1")
				const tabbableElements = focus.tabbable.find(
					linkControlWrapperRef.current
				);
				const nextFocusTarget =
					tabbableElements[ 0 ] || linkControlWrapperRef.current;
				nextFocusTarget.focus();
			}

			// Reset the state
			setShouldFocusPane( false );
		}
	}, [ shouldFocusPane ] );

	const blockEditingMode = useBlockEditingMode();

	return (
		<Popover
			ref={ ref }
			placement="bottom"
			onClose={ props.onClose }
			anchor={ props.anchor }
			shift
		>
			{ ! addingBlock && ! addingPage && (
				<div
					ref={ linkControlWrapperRef }
					role="dialog"
					aria-labelledby={ dialogTitleId }
					aria-describedby={ dialogDescriptionId }
				>
					<VisuallyHidden>
						<h2 id={ dialogTitleId }>{ __( 'Add link' ) }</h2>

						<p id={ dialogDescriptionId }>
							{ __(
								'Search for and add a link to your Navigation.'
							) }
						</p>
					</VisuallyHidden>
					<LinkControl
						hasTextControl
						hasRichPreviews
						value={ link }
						showInitialSuggestions
						withCreateSuggestion={ false }
						noDirectEntry={ !! type }
						noURLSuggestion={ !! type }
						suggestionsQuery={ getSuggestionsQuery( type, kind ) }
						onChange={ props.onChange }
						onInputChange={ ( value ) => {
							// Observe the input value so we can pass the value to the page creator
							// and restore it on back button click
							searchInputValueRef.current = value;
							setSearchValue( value );
						} }
						inputValue={ initialSearchValue }
						onRemove={ props.onRemove }
						onCancel={ props.onCancel }
						handleEntities={ isBoundEntityAvailable }
						forceIsEditingLink={ link?.url ? false : undefined }
						renderControlBottom={ () => {
							// Don't show the tools when there is submitted link (preview state).
							if ( link?.url?.length ) {
								return null;
							}

							return (
								<LinkUITools
									addPageButtonRef={ addPageButtonRef }
									addBlockButtonRef={ addBlockButtonRef }
									setAddingBlock={ () => {
										setAddingBlock( true );
									} }
									setAddingPage={ () => {
										setAddingPage( true );
									} }
									canAddPage={
										permissions?.canCreate &&
										type === 'page'
									}
									canAddBlock={
										blockEditingMode === 'default'
									}
									searchValue={ searchValue }
									matchingNavigationItems={
										matchingNavigationItems
									}
									onInsertNavigationItem={
										handleInlineItemInsert
									}
								/>
							);
						} }
					/>
				</div>
			) }

			{ addingBlock && (
				<LinkUIBlockInserter
					clientId={ props.clientId }
					onBack={ () => {
						setAddingBlock( false );
						setShouldFocusPane( addBlockButtonRef );
						updateSearchValue( searchInputValueRef.current );
					} }
					onBlockInsert={ props?.onBlockInsert }
				/>
			) }

			{ addingPage && (
				<LinkUIPageCreator
					postType={ postType }
					onBack={ () => {
						setAddingPage( false );
						setShouldFocusPane( addPageButtonRef );
						updateSearchValue( searchInputValueRef.current );
					} }
					onPageCreated={ handlePageCreated }
					initialTitle={
						searchInputValueRef.current &&
						! isURL( searchInputValueRef.current )
							? searchInputValueRef.current
							: ''
					}
				/>
			) }
		</Popover>
	);
}

export const LinkUI = forwardRef( UnforwardedLinkUI );

const LinkUITools = ( {
	addPageButtonRef,
	addBlockButtonRef,
	setAddingBlock,
	setAddingPage,
	canAddPage,
	canAddBlock,
	searchValue,
	matchingNavigationItems,
	onInsertNavigationItem,
} ) => {
	const blockInserterAriaRole = 'listbox';
	const hasMatchingNavigationItems =
		canAddBlock &&
		!! searchValue?.trim() &&
		matchingNavigationItems?.length > 0;

	if ( ! canAddPage && ! canAddBlock && ! hasMatchingNavigationItems ) {
		return null;
	}

	return (
		<VStack spacing={ 0 } className="link-ui-tools">
			{ hasMatchingNavigationItems && (
				<>
					<div className="link-ui-tools__section-label">
						{ __( 'Navigation items' ) }
					</div>

					{ matchingNavigationItems.map( ( item ) => (
						<Button
							key={ item.key }
							__next40pxDefaultSize
							onClick={ ( e ) => {
								e.preventDefault();
								onInsertNavigationItem( item );
							} }
						>
							<LinkUIItemIcon icon={ item.icon } />
							<span className="link-ui-tools__block-label">
								{ item.title }
							</span>
						</Button>
					) ) }
				</>
			) }

			{ canAddPage && (
				<Button
					__next40pxDefaultSize
					ref={ addPageButtonRef }
					icon={ plus }
					onClick={ ( e ) => {
						e.preventDefault();
						setAddingPage( true );
					} }
					aria-haspopup={ blockInserterAriaRole }
				>
					{ __( 'Create page' ) }
				</Button>
			) }
			{ canAddBlock && (
				<Button
					__next40pxDefaultSize
					ref={ addBlockButtonRef }
					icon={ plus }
					onClick={ ( e ) => {
						e.preventDefault();
						setAddingBlock( true );
					} }
					aria-haspopup={ blockInserterAriaRole }
				>
					{ __( 'Add block' ) }
				</Button>
			) }
		</VStack>
	);
};

export default LinkUITools;
